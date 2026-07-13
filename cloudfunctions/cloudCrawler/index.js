const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const COL = 'crawlerStatus'
const DOC = 'singleton'
const CHUNK = 20
const INTERNAL_TOKEN = 'cc_internal_v1'
const DETAIL_CONCURRENCY = 8
const ARTIST_CONCURRENCY = 3
const SKIP_KEYWORDS = ['第一期','第二期','第三期','第四期','第五期','第六期','第七期','第八期','第九期','第十期','精选集','合辑','现场版','Live','OST','原声','巅峰对决','新说唱','中国有嘻哈','说唱新世代','浙江卫视','江苏卫视','湖南卫视','东方卫视','北京卫视','央视','CCTV','春晚','晚会','歌会','跨年','元宵','中秋','节目','综艺','盛典','音乐节','演唱会']

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action
  const internal = event.__internal === true && event.__token === INTERNAL_TOKEN
  if (action === 'getStatus') {
    try { return { success: true, status: (await db.collection(COL).doc(DOC).get()).data } }
    catch (e) { return { success: true, status: makeDefault() } }
  }
  if (!internal && !(await isAdmin(OPENID))) return { success: false, error: '无权限' }
  try {
    if (action === 'album') return await runAlbum(String(event.albumId || event.param || ''))
    if (action === 'artist') return await runArtist(String(event.artistId || event.param || ''))
    if (action === 'allApproved') return await runAllApproved(Number(event.cursor || 0))
    return { success: false, error: '未知 action' }
  } catch (e) {
    try { await appendLog(`出错: ${e.message}`); await patchStatus({ status: 'error', completedAt: db.serverDate(), lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [e.message] } }) } catch (x) {}
    return { success: false, error: e.message }
  }
}

async function runAlbum(id) {
  if (!/^\d+$/.test(id)) return { success: false, error: '专辑 ID 必须是数字' }
  await startStatus('album', id, 1)
  const raw = await fetchAlbumById(id)
  if (!raw) return { success: false, error: '未找到专辑（或被风控）' }
  const r = await upsertAlbums([raw], '', { skipFilters: true })
  await doneStatus(1, r.inserted, `专辑《${raw.name || ''}》新增 ${r.inserted} 张，候选 ${r.candidates || 0} 张，补全日期 ${r.dated || 0} 张`)
  return { success: true, ...r }
}

async function runArtist(id) {
  if (!/^\d+$/.test(id)) return { success: false, error: '艺人 ID 必须是数字' }
  await startStatus('artist', id, 1)
  const { name, albums } = await fetchArtistAlbums(id)
  if (!albums.length) return { success: false, error: '未找到专辑（或被风控）' }
  const r = await upsertAlbums(albums, name, { requiredArtistId: id })
  await doneStatus(1, r.inserted, `艺人 ${name || id}：新增 ${r.inserted} 张，候选 ${r.candidates || 0} 张，补全日期 ${r.dated || 0} 张`)
  return { success: true, artistName: name, ...r }
}

async function runAllApproved(cursor) {
  const approved = await db.collection('artist_candidates').where({ status: 'approved' }).field({ artistId: true, artistName: true }).limit(1000).get()
  const list = (approved.data || []).filter(x => x.artistId)
  const total = list.length
  if (!total) { await doneStatus(0, 0, '没有已批准的艺人'); return { success: true, status: 'done', total: 0 } }
  if (cursor === 0) {
    await patchStatus({ status: 'running', mode: 'allApproved', param: '', abort: false, triggeredAt: db.serverDate(), completedAt: null, progress: { totalArtists: total, processedArtists: 0, albumsFound: 0, candidatesFound: 0 }, lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [] }, log: [] })
    await appendLog(`云端全量开始：${total} 位已批准艺人；每 ${CHUNK} 位为一批，${ARTIST_CONCURRENCY} 位并发处理`)
  }
  const slice = list.slice(cursor, cursor + CHUNK)
  let dated = 0, processedCount = 0, aborted = false
  const lock = createMutex()
  await mapWithConcurrency(slice, ARTIST_CONCURRENCY, async (artist, i) => {
    if (aborted) return
    if ((await getStatus()).abort) { aborted = true; return }
    let logLine, added = 0, candidates = 0, artistDated = 0
    try {
      const { albums } = await fetchArtistAlbums(artist.artistId)
      const r = await upsertAlbums(albums, artist.artistName, { requiredArtistId: String(artist.artistId) })
      added = r.inserted; artistDated = r.dated; candidates = r.candidates || 0
      const count = await db.collection('albums').where(_.or([{ artistIds: _.all([String(artist.artistId)]) }, { neteaseArtistId: String(artist.artistId) }])).count()
      await db.collection('artist_candidates').doc(artist._id).update({ data: { albumSize: count.total } })
      logLine = `[${cursor + i + 1}/${total}] ${artist.artistName}: 新增${r.inserted}张，候选${r.candidates || 0}张，过滤${r.skipped || 0}张，日期写入${r.dated}张`
    } catch (e) { logLine = `[${cursor + i + 1}/${total}] ${artist.artistName} 失败: ${e.message}` }
    await lock(async () => {
      processedCount += 1; dated += artistDated
      await appendLog(logLine)
      const now = await getStatus(); const p = now.progress || {}
      await patchStatus({ lastProgressAt: db.serverDate(), progress: { totalArtists: total, processedArtists: cursor + processedCount, albumsFound: Number(p.albumsFound || 0) + added, candidatesFound: Number(p.candidatesFound || 0) + candidates } })
      if ((await getStatus()).abort) aborted = true
    })
  })
  if (aborted) {
    const st = await getStatus()
    await finishAbort(st, total)
    return { success: true, status: 'aborted', processed: cursor + processedCount, total }
  }
  const processed = Math.min(cursor + CHUNK, total)
  if (processed < total) {
    // 链式：本批已处理完，立刻 fire-and-forget 触发下一批（不 await 其完整执行），让整轮全量一批接一批自己跑完，
    // 而不是每批都干等 5 分钟定时器。为什么不 await：await 会把整条链嵌套在这一次同步调用里，几批之后必然撞 60s 超时。
    await selfInvokeNext(processed)
    return { success: true, status: 'running', processed, total, dated }
  }
  const status = await getStatus(), p = status.progress || {}
  await patchStatus({ status: 'done', abort: false, completedAt: db.serverDate(), lastRunSummary: { newAlbums: Number(p.albumsFound || 0), newCandidates: Number(p.candidatesFound || 0), errors: [] } })
  await appendLog(`云端全量完成：新增 ${Number(p.albumsFound || 0)} 张，候选 ${Number(p.candidatesFound || 0)} 张，日期写入 ${dated} 张`)
  return { success: true, status: 'done', total, newAlbums: Number(p.albumsFound || 0), newCandidates: Number(p.candidatesFound || 0), dated }
}

// 触发下一批 cloudCrawler。刻意不 await 其完整执行（见上方调用处注释）：
// 只等一小会儿让"调用下一批"这个请求真正发出去，降低"容器 return 后被冻结、导致下一批没被真正触发"的概率。
// "return 之后未 await 的异步是否仍执行"官方并无明确保证，所以这里只是尽量提高成功率，
// 真正的兜底是 cloudCrawlerDailyTrigger 里的看门狗：链条一旦卡住（超时无进度）会接力恢复。
async function selfInvokeNext(cursor) {
  try {
    const p = cloud.callFunction({ name: 'cloudCrawler', data: { action: 'allApproved', cursor, __internal: true, __token: INTERNAL_TOKEN } })
    if (p && typeof p.catch === 'function') p.catch(() => {}) // 吞掉链上 rejection，避免 unhandledRejection
  } catch (e) {}
  await new Promise(r => setTimeout(r, 800))
}

async function finishAbort(status, total) {
  const p = status.progress || {}
  await patchStatus({ status: 'aborted', abort: false, completedAt: db.serverDate(), progress: { totalArtists: total, processedArtists: Number(p.processedArtists || 0), albumsFound: Number(p.albumsFound || 0), candidatesFound: Number(p.candidatesFound || 0) }, lastRunSummary: { newAlbums: Number(p.albumsFound || 0), newCandidates: Number(p.candidatesFound || 0), errors: ['用户中止'] } })
  await appendLog('任务已中止；已写入的数据会保留')
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } }, res => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { resolve(null) } })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}
async function fetchArtistAlbums(id) { const albums = []; let offset = 0, name = ''; while (true) { let data; try { data = await httpsGet(`https://music.163.com/api/artist/albums/${id}?limit=50&offset=${offset}`) } catch (e) { break } if (!data || data.code !== 200) break; if (!name) name = ((data.artist || {}).name || ''); const batch = data.hotAlbums || []; albums.push(...batch); if (!data.more || !batch.length) break; offset += 50 } return { name, albums } }
async function fetchAlbumById(id) { const data = await httpsGet(`https://music.163.com/api/v1/album/${id}`); return data && data.code === 200 ? data.album : null }
async function fetchAlbumDetail(id) { const data = await httpsGet(`https://music.163.com/api/v1/album/${id}`); return data && data.code === 200 ? data : null }
function releaseDateFromTime(v) { const t = Number(v); if (!t) return ''; const d = new Date(t); if (Number.isNaN(d.getTime())) return ''; return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` }
function hasBadKeyword(title){ return SKIP_KEYWORDS.some(k => title.includes(k)) }
function normalizeAlbum(raw, fallbackArtist, opts) { opts = opts || {}; const title = String(raw.name || '').trim(); const rawArtists = raw.artists || (raw.artist ? [raw.artist] : []); const artistIds = Array.from(new Set(rawArtists.map(x => x && x.id ? String(x.id) : '').filter(Boolean))); if (opts.requiredArtistId && !artistIds.includes(String(opts.requiredArtistId))) return null; const primaryArtist = String((raw.artist || {}).name || fallbackArtist || '').trim(); const artists = rawArtists.map(x => String(x && x.name || '').trim()).filter(Boolean); const artist = artists.length > 1 ? artists.join(' / ') : primaryArtist; const sourceId = String(raw.id || ''); const coverUrl = raw.picUrl || raw.blurPicUrl || ''; const releaseDate = releaseDateFromTime(raw.publishTime); const releaseYear = releaseDate ? Number(releaseDate.slice(0, 4)) : 0; const trackCount = Number(raw.size || 0); if (!title || !primaryArtist || !coverUrl || !sourceId) return null; if (!opts.skipFilters) { const now = new Date().getFullYear(); if (releaseYear < 1990 || releaseYear > now + 1 || trackCount < 3 || hasBadKeyword(title)) return null } return { title, artist, primaryArtist, neteaseArtistId: raw.artist && raw.artist.id ? String(raw.artist.id) : '', artistIds, sourceId, coverUrl, releaseYear, releaseDate, genres: [], source: 'netease', crawlSource: 'cloud', avgScore: 0, reviewCount: 0, trackCount } }
function normalizeTrackName(name) { return String(name || '').replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '').replace(/(伴奏|instrumental|inst\.?|off\s*vocal|karaoke|纯音乐|伴奏版|伴奏带)/ig, '').replace(/[\s\-_.·]/g, '').toLowerCase() }
function inspectAlbumTracks(songs) { const names = (songs || []).map(s => String(s.name || '').trim()).filter(Boolean); const accompaniment = names.filter(n => n.includes('伴奏')); const realCount = names.length - accompaniment.length; const normalized = names.map(normalizeTrackName).filter(Boolean); const allSame = normalized.length >= 2 && new Set(normalized).size === 1; if (realCount < 3) return { bad: true, reason: '剔除伴奏曲目后正式曲目不足3首', example: accompaniment.slice(0, 4) }; if (allSame) return { bad: true, reason: '全专曲目名称重复', example: names.slice(0, 4) }; return { bad: false } }
async function upsertCandidate(album, verdict) { const found = await db.collection('album_candidates').where({ sourceId: album.sourceId }).limit(1).get(); if (found.data.length) return false; await db.collection('album_candidates').add({ data: Object.assign({}, album, { approved: false, crawlSource: 'cloud-initial-quality-filter', candidateReason: verdict.reason, duplicateTrackExample: verdict.example || [], status: 'pending', addedAt: db.serverDate(), decidedAt: null }) }); return true }
async function mapWithConcurrency(items, limit, fn) { const output = new Array(items.length); let cursor = 0; const workers = Array.from({ length: Math.min(limit, items.length) }, async () => { while (true) { const i = cursor++; if (i >= items.length) return; output[i] = await fn(items[i], i) } }); await Promise.all(workers); return output }
function createMutex() { let queue = Promise.resolve(); return fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run } }
async function upsertAlbums(rawList, fallbackArtist, opts) { opts = opts || {}; let skipped = 0; const albums = rawList.map(x => { const a = normalizeAlbum(x, fallbackArtist, opts); if (!a) skipped++; return a }).filter(Boolean); if (!albums.length) return { inserted: 0, total: 0, dated: 0, candidates: 0, skipped }; const ids = albums.map(x => x.sourceId); const existing = new Map(); for (let i = 0; i < ids.length; i += 100) { const res = await db.collection('albums').where({ sourceId: _.in(ids.slice(i, i + 100)) }).field({ _id: true, sourceId: true, releaseDate: true, releaseYear: true, neteaseArtistId: true, artistIds: true, primaryArtist: true, trackCount: true }).get(); (res.data || []).forEach(x => existing.set(x.sourceId, x)) } let inserted = 0, dated = 0, candidates = 0; await mapWithConcurrency(albums, DETAIL_CONCURRENCY, async album => { const old = existing.get(album.sourceId); if (old) { const patch = {}; if (!old.releaseDate && album.releaseDate) { patch.releaseDate = album.releaseDate; patch.releaseYear = album.releaseYear; dated += 1 }; if (!old.neteaseArtistId && album.neteaseArtistId) patch.neteaseArtistId = album.neteaseArtistId; if (!old.primaryArtist && album.primaryArtist) patch.primaryArtist = album.primaryArtist; if (!old.trackCount && album.trackCount) patch.trackCount = album.trackCount; const oldArtistIds = Array.isArray(old.artistIds) ? old.artistIds : []; if (album.artistIds && album.artistIds.length && JSON.stringify(oldArtistIds) !== JSON.stringify(album.artistIds)) patch.artistIds = album.artistIds; if (Object.keys(patch).length) await db.collection('albums').doc(old._id).update({ data: patch }); return } try { const detail = await fetchAlbumDetail(album.sourceId), verdict = inspectAlbumTracks(detail && detail.songs); if (verdict.bad) { if (await upsertCandidate(album, verdict)) candidates++; return } } catch (e) {} await db.collection('albums').add({ data: Object.assign({ approved: true }, album) }); inserted++; if (album.releaseDate) dated++ }); return { inserted, total: albums.length, dated, candidates, skipped } }
async function isAdmin(openId) { if (!openId) return false; const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get(); return r.data.length > 0 }
async function getStatus() { try { return (await db.collection(COL).doc(DOC).get()).data } catch (e) { return makeDefault() } }
function makeDefault() { return { status: 'idle', log: [], progress: { totalArtists: 0, processedArtists: 0, albumsFound: 0, candidatesFound: 0 }, lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [] }, abort: false } }
async function patchStatus(data) { const current = await getStatus(); const next = Object.assign({}, makeDefault(), current, data); delete next._id; if (current.progress && data.progress) next.progress = Object.assign({}, current.progress, data.progress); await db.collection(COL).doc(DOC).set({ data: next }) }
async function startStatus(mode, param, total) { await patchStatus({ status: 'running', mode, param, abort: false, triggeredAt: db.serverDate(), completedAt: null, progress: { totalArtists: total, processedArtists: 0, albumsFound: 0, candidatesFound: 0 } }) }
async function doneStatus(total, inserted, log) { await patchStatus({ status: 'done', abort: false, completedAt: db.serverDate(), progress: { totalArtists: total, processedArtists: total, albumsFound: inserted, candidatesFound: 0 }, lastRunSummary: { newAlbums: inserted, newCandidates: 0, errors: [] } }); await appendLog(log) }
async function appendLog(text) { const s = await getStatus(), logs = Array.isArray(s.log) ? s.log : (Array.isArray(s.logs) ? s.logs.map(x => typeof x === 'string' ? x : x.text || '') : []); const ts = new Date().toISOString().slice(11,19); logs.unshift(`[${ts}] ${text}`); await patchStatus({ log: logs.slice(0, 80) }) }
