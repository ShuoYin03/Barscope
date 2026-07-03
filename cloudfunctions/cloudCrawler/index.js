const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const COL = 'crawlerStatus'
const DOC = 'singleton'
const CHUNK = 50
const INTERNAL_TOKEN = 'cc_internal_v1'
const DETAIL_CONCURRENCY = 8
const SKIP_KEYWORDS = ['第一期','第二期','第三期','第四期','第五期','第六期','第七期','第八期','第九期','第十期','精选集','合辑','现场版','Live','OST','原声','巅峰对决','新说唱','中国有嘻哈','说唱新世代']

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action
  const internal = event.__internal === true && event.__token === INTERNAL_TOKEN
  if (action === 'getStatus') { try { return { success: true, status: (await db.collection(COL).doc(DOC).get()).data } } catch (e) { return { success: true, status: makeDefault() } } }
  if (!internal && !(await isAdmin(OPENID))) return { success: false, error: '无权限' }
  try {
    if (action === 'album') return await runAlbum(String(event.albumId || event.param || ''))
    if (action === 'artist') return await runArtist(String(event.artistId || event.param || ''))
    if (action === 'allApproved') return await runAllApproved(Number(event.cursor || 0))
    return { success: false, error: '未知 action' }
  } catch (e) {
    await appendLog(`出错: ${e.message}`)
    await patchStatus({ status: 'error', completedAt: db.serverDate(), lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [e.message] } })
    return { success: false, error: e.message }
  }
}

async function runAlbum(albumId) {
  if (!/^\d+$/.test(albumId)) return { success: false, error: '专辑 ID 必须是数字' }
  await startStatus('album', albumId, 1)
  const raw = await fetchAlbumById(albumId)
  if (!raw) return { success: false, error: '未找到该专辑（或被风控）' }
  const result = await upsertAlbums([raw], '', { skipFilters: true })
  await doneStatus(1, result.inserted, `专辑《${raw.name || ''}》新增 ${result.inserted} 张，候选 ${result.candidates || 0} 张，补全日期 ${result.dated || 0} 张`)
  return { success: true, ...result }
}

async function runArtist(artistId) {
  if (!/^\d+$/.test(artistId)) return { success: false, error: '艺人 ID 必须是数字' }
  await startStatus('artist', artistId, 1)
  const { name, albums } = await fetchArtistAlbums(artistId)
  if (!albums.length) return { success: false, error: '未找到专辑（或被风控）' }
  const result = await upsertAlbums(albums, name)
  await doneStatus(1, result.inserted, `艺人 ${name || artistId}：新增 ${result.inserted} 张，候选 ${result.candidates || 0} 张，补全日期 ${result.dated || 0} 张`)
  return { success: true, artistName: name, ...result }
}

async function runAllApproved(cursor) {
  const approved = await db.collection('artist_candidates').where({ status: 'approved' }).field({ artistId: true, artistName: true }).limit(1000).get()
  const list = (approved.data || []).filter(x => x.artistId)
  const total = list.length
  if (!total) { await doneStatus(0, 0, '没有已批准的艺人'); return { success: true, status: 'done', total: 0 } }
  if (cursor === 0) {
    await patchStatus({ status: 'running', mode: 'allApproved', param: '', abort: false, triggeredAt: db.serverDate(), completedAt: null, progress: { totalArtists: total, processedArtists: 0, albumsFound: 0, candidatesFound: 0 }, lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [] } })
    await appendLog(`云端全量开始：${total} 位已批准艺人；伴奏/重复曲目专辑将直接进入候选区`)
  }
  if (await isAbortRequested()) return { success: true, status: 'aborted' }
  const slice = list.slice(cursor, cursor + CHUNK)
  let added = 0, dated = 0, candidates = 0
  for (let i = 0; i < slice.length; i += 1) {
    const artist = slice[i]
    try {
      const { albums } = await fetchArtistAlbums(artist.artistId)
      const result = await upsertAlbums(albums, artist.artistName)
      added += result.inserted; dated += result.dated; candidates += result.candidates || 0
      const count = await db.collection('albums').where({ neteaseArtistId: String(artist.artistId) }).count()
      await db.collection('artist_candidates').doc(artist._id).update({ data: { albumSize: count.total } })
      await appendLog(`[${cursor + i + 1}/${total}] ${artist.artistName}: 新增${result.inserted}张，候选${result.candidates || 0}张，日期写入${result.dated}张`)
    } catch (e) { await appendLog(`[${cursor + i + 1}/${total}] ${artist.artistName} 失败: ${e.message}`) }
  }
  const processed = Math.min(cursor + CHUNK, total)
  const status = await getStatus()
  const oldAlbums = Number((status.progress || {}).albumsFound || 0)
  const oldCandidates = Number((status.progress || {}).candidatesFound || 0)
  await patchStatus({ progress: { totalArtists: total, processedArtists: processed, albumsFound: oldAlbums + added, candidatesFound: oldCandidates + candidates } })
  if (processed < total) { await cloud.callFunction({ name: 'cloudCrawler', data: { action: 'allApproved', cursor: processed, __internal: true, __token: INTERNAL_TOKEN } }); return { success: true, status: 'running', processed, total, inserted: added, candidates, dated } }
  await patchStatus({ status: 'done', completedAt: db.serverDate(), lastRunSummary: { newAlbums: oldAlbums + added, newCandidates: oldCandidates + candidates, errors: [] } })
  await appendLog(`云端全量完成：新增 ${oldAlbums + added} 张，候选 ${oldCandidates + candidates} 张，日期写入 ${dated} 张`)
  return { success: true, status: 'done', total, newAlbums: oldAlbums + added, newCandidates: oldCandidates + candidates, dated }
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } }, res => { let body = ''; res.on('data', c => { body += c }); res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { resolve(null) } }) })
    req.on('error', reject); req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function fetchArtistAlbums(artistId) {
  const albums = []; let offset = 0; let name = ''
  while (true) { let data; try { data = await httpsGet(`https://music.163.com/api/artist/albums/${artistId}?limit=50&offset=${offset}`) } catch (e) { break }; if (!data || data.code !== 200) break; if (!name) name = ((data.artist || {}).name || ''); const batch = data.hotAlbums || []; albums.push(...batch); if (!data.more || !batch.length) break; offset += 50 }
  return { name, albums }
}
async function fetchAlbumById(id) { const data = await httpsGet(`https://music.163.com/api/v1/album/${id}`); return data && data.code === 200 ? data.album : null }
async function fetchAlbumDetail(id) { const data = await httpsGet(`https://music.163.com/api/v1/album/${id}`); return data && data.code === 200 ? data : null }
function releaseDateFromTime(value) { const timestamp = Number(value); if (!timestamp) return ''; const d = new Date(timestamp); if (Number.isNaN(d.getTime())) return ''; const y = d.getUTCFullYear(); const m = String(d.getUTCMonth() + 1).padStart(2, '0'); const day = String(d.getUTCDate()).padStart(2, '0'); return `${y}-${m}-${day}` }

function normalizeAlbum(raw, fallbackArtist, opts) {
  opts = opts || {}; const title = String(raw.name || '').trim(); const primaryArtist = String((raw.artist || {}).name || fallbackArtist || '').trim(); const artists = (raw.artists || []).map(x => String(x.name || '').trim()).filter(Boolean); const artist = artists.length > 1 ? artists.join(' / ') : primaryArtist; const sourceId = String(raw.id || ''); const coverUrl = raw.picUrl || raw.blurPicUrl || ''; const releaseDate = releaseDateFromTime(raw.publishTime); const releaseYear = releaseDate ? Number(releaseDate.slice(0, 4)) : 0; const trackCount = Number(raw.size || 0)
  if (!title || !primaryArtist || !coverUrl || !sourceId) return null
  if (!opts.skipFilters) { const now = new Date().getFullYear(); if (releaseYear < 1990 || releaseYear > now + 1 || trackCount < 3 || SKIP_KEYWORDS.some(k => title.includes(k))) return null }
  return { title, artist, primaryArtist, neteaseArtistId: raw.artist && raw.artist.id ? String(raw.artist.id) : '', sourceId, coverUrl, releaseYear, releaseDate, genres: [], source: 'netease', crawlSource: 'cloud', avgScore: 0, reviewCount: 0, trackCount }
}

function normalizeTrackName(name) { return String(name || '').replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '').replace(/(伴奏|instrumental|inst\.?|off\s*vocal|karaoke|纯音乐|伴奏版|伴奏带)/ig, '').replace(/[\s\-_.·]/g, '').toLowerCase() }
function inspectAlbumTracks(songs) {
  const names = (songs || []).map(s => String(s.name || '').trim()).filter(Boolean)
  const accompaniment = names.filter(n => /(伴奏|instrumental|inst\.?|off\s*vocal|karaoke|纯音乐|伴奏版|伴奏带)/i.test(n))
  const normalized = names.map(normalizeTrackName).filter(Boolean)
  const allSame = normalized.length >= 2 && new Set(normalized).size === 1
  if (accompaniment.length) return { bad: true, reason: '含有伴奏/纯音乐版本曲目', example: accompaniment.slice(0, 4) }
  if (allSame) return { bad: true, reason: '全专曲目名称重复', example: names.slice(0, 4) }
  return { bad: false }
}

async function upsertCandidate(album, verdict) {
  const found = await db.collection('album_candidates').where({ sourceId: album.sourceId }).limit(1).get()
  if (found.data.length) return false
  await db.collection('album_candidates').add({ data: Object.assign({}, album, { approved: false, crawlSource: 'cloud-initial-quality-filter', candidateReason: verdict.reason, duplicateTrackExample: verdict.example || [], status: 'pending', addedAt: db.serverDate(), decidedAt: null }) })
  return true
}

async function mapWithConcurrency(items, limit, fn) {
  const output = new Array(items.length); let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => { while (true) { const i = cursor++; if (i >= items.length) return; output[i] = await fn(items[i]) } })
  await Promise.all(workers); return output
}

async function upsertAlbums(rawList, fallbackArtist, opts) {
  const albums = rawList.map(x => normalizeAlbum(x, fallbackArtist, opts)).filter(Boolean)
  if (!albums.length) return { inserted: 0, total: 0, dated: 0, candidates: 0 }
  const ids = albums.map(x => x.sourceId); const existing = new Map()
  for (let i = 0; i < ids.length; i += 100) { const res = await db.collection('albums').where({ sourceId: _.in(ids.slice(i, i + 100)) }).field({ _id: true, sourceId: true, releaseDate: true, releaseYear: true, neteaseArtistId: true, primaryArtist: true, trackCount: true }).get(); (res.data || []).forEach(x => existing.set(x.sourceId, x)) }
  let inserted = 0, dated = 0, candidates = 0
  await mapWithConcurrency(albums, DETAIL_CONCURRENCY, async album => {
    const old = existing.get(album.sourceId)
    // Existing records are left alone; initial filtering applies before a new album enters the formal library.
    if (old) {
      const patch = {}; if (!old.releaseDate && album.releaseDate) { patch.releaseDate = album.releaseDate; patch.releaseYear = album.releaseYear; dated += 1 }; if (!old.neteaseArtistId && album.neteaseArtistId) patch.neteaseArtistId = album.neteaseArtistId; if (!old.primaryArtist && album.primaryArtist) patch.primaryArtist = album.primaryArtist; if (!old.trackCount && album.trackCount) patch.trackCount = album.trackCount; if (Object.keys(patch).length) await db.collection('albums').doc(old._id).update({ data: patch }); return
    }
    try {
      const detail = await fetchAlbumDetail(album.sourceId)
      const verdict = inspectAlbumTracks(detail && detail.songs)
      if (verdict.bad) { if (await upsertCandidate(album, verdict)) candidates += 1; return }
    } catch (e) {
      // Do not discard a normal album merely because an upstream detail call failed.
    }
    await db.collection('albums').add({ data: Object.assign({ approved: true }, album) }); inserted += 1; if (album.releaseDate) dated += 1
  })
  return { inserted, total: albums.length, dated, candidates }
}

async function isAdmin(openId) { if (!openId) return false; const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get(); return r.data.length > 0 }
async function getStatus() { try { return (await db.collection(COL).doc(DOC).get()).data } catch (e) { return makeDefault() } }
async function patchStatus(fields) { const r = await db.collection(COL).doc(DOC).update({ data: fields }); if (!r.stats || !r.stats.updated) await db.collection(COL).doc(DOC).set({ data: Object.assign(makeDefault(), fields) }) }
async function appendLog(line) { try { await db.collection(COL).doc(DOC).update({ data: { log: _.push({ each: [`[${new Date().toISOString().slice(11, 19)}] ${line}`], slice: -80 }) } }) } catch (e) {} }
async function startStatus(mode, param, total) { await patchStatus({ status: 'running', mode, param, triggeredAt: db.serverDate(), completedAt: null, progress: { totalArtists: total, processedArtists: 0, albumsFound: 0, candidatesFound: 0 } }) }
async function doneStatus(total, inserted, text) { await patchStatus({ status: 'done', completedAt: db.serverDate(), progress: { totalArtists: total, processedArtists: total, albumsFound: inserted, candidatesFound: 0 }, lastRunSummary: { newAlbums: inserted, newCandidates: 0, errors: [] } }); await appendLog(text) }
async function isAbortRequested() { try { return !!(await db.collection(COL).doc(DOC).get()).data.abort } catch (e) { return false } }
function makeDefault() { return { status: 'idle', triggeredAt: null, completedAt: null, mode: '', param: '', abort: false, progress: { totalArtists: 0, processedArtists: 0, albumsFound: 0, candidatesFound: 0 }, lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [] }, schedule: { enabled: false, interval: 'weekly', nextRun: null }, log: [] } }