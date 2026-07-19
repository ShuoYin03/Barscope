const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const COL = 'crawlerStatus'
const DOC = 'singleton'
// 之前是 20：当 cloudCrawlerDailyTrigger 需要 await 完整跑完一批时（自链 fire-and-forget 不可靠，
// 详见 cloudCrawlerDailyTrigger/index.js 的注释），批次越大越容易撞 cloud.callFunction 自身的
// socket 超时。调小到 10 换取更高的单批成功率，代价是全量一轮需要更多批次。
const CHUNK = 10
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
    if (action === 'autoBatch') return await runAutoBatch(Array.isArray(event.ids) ? event.ids : [])
    if (action === 'abort') return await abortRun()
    if (action === 'clearLog') { await patchStatus({ log: [] }); return { success: true } }
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
  await doneStatus(1, r.inserted, `专辑《${raw.name || ''}》新增 ${r.inserted} 张，候选 ${r.candidates || 0} 张，拦截已删除 ${r.blocked || 0} 张，补全日期 ${r.dated || 0} 张`)
  return { success: true, ...r }
}

async function runArtist(id) {
  if (!/^\d+$/.test(id)) return { success: false, error: '艺人 ID 必须是数字' }
  await startStatus('artist', id, 1)
  const { name, albums } = await fetchArtistAlbums(id)
  if (!albums.length) return { success: false, error: '未找到专辑（或被风控）' }
  const r = await upsertAlbums(albums, name, { requiredArtistId: id })
  await doneStatus(1, r.inserted, `艺人 ${name || id}：新增 ${r.inserted} 张，候选 ${r.candidates || 0} 张，拦截已删除 ${r.blocked || 0} 张，补全日期 ${r.dated || 0} 张`)
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
      logLine = `[${cursor + i + 1}/${total}] ${artist.artistName}: 新增${r.inserted}张，候选${r.candidates || 0}张，过滤${r.skipped || 0}张，拦截已删除${r.blocked || 0}张，日期写入${r.dated}张`
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

// 由 cloudCrawlerDailyTrigger 的定时状态机调用（await，可靠，不是老那种 fire-and-forget 链）。
// 触发器每 tick 会分很多小撮来调，每撮就几位艺人；这里只管「给几个就老实抓几个、拿全、返回每个 id 的成/败」，
// 不做时间预算、不给单艺人设限——快慢由触发器那边用「每小撮跑完就 checkpoint 落库」来兜底（被杀也不丢进度）。
async function runAutoBatch(ids) {
  const succeeded = [], failed = []
  let albumsFound = 0, candidatesFound = 0, dated = 0, lastLog = ''
  const results = await mapWithConcurrency(ids, ARTIST_CONCURRENCY, async a => {
    const aid = String(a.artistId)
    try {
      const { albums } = await fetchArtistAlbums(aid) // 拿全部专辑，不封顶
      const r = await upsertAlbums(albums, a.artistName, { requiredArtistId: aid })
      return { aid, ok: true, name: a.artistName || aid, added: r.inserted, cand: r.candidates || 0, dated: r.dated }
    } catch (e) { return { aid, ok: false, name: a.artistName || aid } }
  })
  for (const r of results) {
    if (r.ok) { succeeded.push(r.aid); albumsFound += r.added; candidatesFound += r.cand; dated += r.dated; lastLog = `${r.name}: 新增${r.added}张，候选${r.cand}张，日期${r.dated}张` }
    else { failed.push(r.aid) }
  }
  return { success: true, succeeded, failed, albumsFound, candidatesFound, dated, lastLog }
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
const PINYIN_STARTS = [['A','阿'],['B','芭'],['C','嚓'],['D','搭'],['E','蛾'],['F','发'],['G','噶'],['H','哈'],['J','击'],['K','喀'],['L','垃'],['M','妈'],['N','拿'],['O','哦'],['P','啪'],['Q','期'],['R','然'],['S','撒'],['T','塌'],['W','挖'],['X','昔'],['Y','压'],['Z','匝']]
function pinyinInitial(ch){ let letter='#'; for(const [initial,startChar] of PINYIN_STARTS){ if(ch.localeCompare(startChar,'zh-Hans-CN-u-co-pinyin')>=0)letter=initial; else break } return letter }
function firstLetter(name){ for(const ch of Array.from(String(name||'').trim())){ if(/[A-Za-z]/.test(ch))return ch.toUpperCase(); if(/[一-鿿]/.test(ch))return pinyinInitial(ch) } return '#' }
function normalizeAlbum(raw, fallbackArtist, opts) { opts = opts || {}; const title = String(raw.name || '').trim(); const rawArtists = raw.artists || (raw.artist ? [raw.artist] : []); const artistIds = Array.from(new Set(rawArtists.map(x => x && x.id ? String(x.id) : '').filter(Boolean))); if (opts.requiredArtistId && !artistIds.includes(String(opts.requiredArtistId))) return null; const primaryArtist = String((raw.artist || {}).name || fallbackArtist || '').trim(); const artists = rawArtists.map(x => String(x && x.name || '').trim()).filter(Boolean); const artist = artists.length > 1 ? artists.join(' / ') : primaryArtist; const sourceId = String(raw.id || ''); const coverUrl = raw.picUrl || raw.blurPicUrl || ''; const releaseDate = releaseDateFromTime(raw.publishTime); const releaseYear = releaseDate ? Number(releaseDate.slice(0, 4)) : 0; const trackCount = Number(raw.size || 0); if (!title || !primaryArtist || !coverUrl || !sourceId) return null; if (!opts.skipFilters) { const now = new Date().getFullYear(); if (releaseYear < 1990 || releaseYear > now + 1 || trackCount < 3 || hasBadKeyword(title)) return null } return { title, artist, primaryArtist, neteaseArtistId: raw.artist && raw.artist.id ? String(raw.artist.id) : '', artistIds, sourceId, coverUrl, releaseYear, releaseDate, genres: [], source: 'netease', crawlSource: 'cloud', avgScore: 0, reviewCount: 0, trackCount, titleLetter: firstLetter(title), isMultiArtist: artistIds.length > 1 } }
function normalizeTrackName(name) { return String(name || '').replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '').replace(/(伴奏|instrumental|inst\.?|off\s*vocal|karaoke|纯音乐|伴奏版|伴奏带)/ig, '').replace(/[\s\-_.·]/g, '').toLowerCase() }
function inspectAlbumTracks(songs) { const names = (songs || []).map(s => String(s.name || '').trim()).filter(Boolean); const accompaniment = names.filter(n => n.includes('伴奏')); const realCount = names.length - accompaniment.length; const normalized = names.map(normalizeTrackName).filter(Boolean); const allSame = normalized.length >= 2 && new Set(normalized).size === 1; if (realCount < 3) return { bad: true, reason: '剔除伴奏曲目后正式曲目不足3首', example: accompaniment.slice(0, 4) }; if (allSame) return { bad: true, reason: '全专曲目名称重复', example: names.slice(0, 4) }; return { bad: false } }
async function upsertCandidate(album, verdict) { const found = await db.collection('album_candidates').where({ sourceId: album.sourceId }).limit(1).get(); if (found.data.length) return false; await db.collection('album_candidates').add({ data: Object.assign({}, album, { approved: false, crawlSource: 'cloud-initial-quality-filter', candidateReason: verdict.reason, duplicateTrackExample: verdict.example || [], status: 'pending', addedAt: db.serverDate(), decidedAt: null }) }); return true }
async function mapWithConcurrency(items, limit, fn) { const output = new Array(items.length); let cursor = 0; const workers = Array.from({ length: Math.min(limit, items.length) }, async () => { while (true) { const i = cursor++; if (i >= items.length) return; output[i] = await fn(items[i], i) } }); await Promise.all(workers); return output }
function createMutex() { let queue = Promise.resolve(); return fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run } }
// An admin hard-deleting a candidate/hidden album removes the albums doc entirely but keeps (or
// creates) an album_candidates record — status:'deleted' if a human rejected it, status:'pending' if
// an automated quality rescreen flagged it and no one has reviewed it yet. Either way that sourceId is
// not currently cleared for the library, so re-crawling that artist must not silently re-approve it
// just because the albums doc happens to be gone. Anything other than status:'kept' blocks re-insertion.
async function fetchBlockedSourceIds(ids) { const blocked = new Set(); for (let i = 0; i < ids.length; i += 100) { const res = await db.collection('album_candidates').where({ sourceId: _.in(ids.slice(i, i + 100)), status: _.neq('kept') }).field({ sourceId: true }).get(); (res.data || []).forEach(x => { if (x.sourceId) blocked.add(String(x.sourceId)) }) } return blocked }
async function upsertAlbums(rawList, fallbackArtist, opts) { opts = opts || {}; let skipped = 0; const albums = rawList.map(x => { const a = normalizeAlbum(x, fallbackArtist, opts); if (!a) skipped++; return a }).filter(Boolean); if (!albums.length) return { inserted: 0, total: 0, dated: 0, candidates: 0, skipped, blocked: 0 }; const ids = albums.map(x => x.sourceId); const existing = new Map(); for (let i = 0; i < ids.length; i += 100) { const res = await db.collection('albums').where({ sourceId: _.in(ids.slice(i, i + 100)) }).field({ _id: true, sourceId: true, releaseDate: true, releaseYear: true, neteaseArtistId: true, artistIds: true, primaryArtist: true, trackCount: true, ownershipSource: true }).get(); (res.data || []).forEach(x => existing.set(x.sourceId, x)) } const blockedIds = await fetchBlockedSourceIds(ids.filter(id => !existing.has(id))); let inserted = 0, dated = 0, candidates = 0, blocked = 0; await mapWithConcurrency(albums, DETAIL_CONCURRENCY, async album => { const old = existing.get(album.sourceId); if (old) { const patch = {}; if (!old.releaseDate && album.releaseDate) { patch.releaseDate = album.releaseDate; patch.releaseYear = album.releaseYear; dated += 1 }; if (!old.trackCount && album.trackCount) patch.trackCount = album.trackCount; if (old.ownershipSource !== 'user-admin-correction') { if (!old.neteaseArtistId && album.neteaseArtistId) patch.neteaseArtistId = album.neteaseArtistId; if (!old.primaryArtist && album.primaryArtist) patch.primaryArtist = album.primaryArtist; const oldArtistIds = Array.isArray(old.artistIds) ? old.artistIds : []; if (album.artistIds && album.artistIds.length && JSON.stringify(oldArtistIds) !== JSON.stringify(album.artistIds)) patch.artistIds = album.artistIds } if (Object.keys(patch).length) await db.collection('albums').doc(old._id).update({ data: patch }); return } if (blockedIds.has(album.sourceId)) { blocked += 1; return } try { const detail = await fetchAlbumDetail(album.sourceId), verdict = inspectAlbumTracks(detail && detail.songs); if (verdict.bad) { if (await upsertCandidate(album, verdict)) candidates++; return }; const raced = await db.collection('albums').where({ sourceId: album.sourceId }).limit(1).get(); if (raced.data.length) return; await db.collection('albums').add({ data: Object.assign({ approved: true }, album) }); inserted++; if (album.releaseDate) dated++ } catch (e) {} }); return { inserted, total: albums.length, dated, candidates, skipped, blocked } }
async function isAdmin(openId) { if (!openId) return false; const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get(); return r.data.length > 0 }
async function getStatus() { try { return (await db.collection(COL).doc(DOC).get()).data } catch (e) { return makeDefault() } }
function makeDefault() { return { status: 'idle', log: [], progress: { totalArtists: 0, processedArtists: 0, albumsFound: 0, candidatesFound: 0 }, lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [] }, abort: false } }
async function patchStatus(data) { const current = await getStatus(); const next = Object.assign({}, makeDefault(), current, data); delete next._id; if (current.progress && data.progress) next.progress = Object.assign({}, current.progress, data.progress); await db.collection(COL).doc(DOC).set({ data: next }) }
async function startStatus(mode, param, total) { await patchStatus({ status: 'running', mode, param, abort: false, triggeredAt: db.serverDate(), completedAt: null, progress: { totalArtists: total, processedArtists: 0, albumsFound: 0, candidatesFound: 0 } }) }
async function doneStatus(total, inserted, log) { await patchStatus({ status: 'done', abort: false, completedAt: db.serverDate(), progress: { totalArtists: total, processedArtists: total, albumsFound: inserted, candidatesFound: 0 }, lastRunSummary: { newAlbums: inserted, newCandidates: 0, errors: [] } }); await appendLog(log) }
async function appendLog(text) { const s = await getStatus(), logs = Array.isArray(s.log) ? s.log : (Array.isArray(s.logs) ? s.logs.map(x => typeof x === 'string' ? x : x.text || '') : []); const ts = new Date().toISOString().slice(11,19); logs.unshift(`[${ts}] ${text}`); await patchStatus({ log: logs.slice(0, 80) }) }
async function abortRun() {
  const cur = await getStatus()
  if (cur.status !== 'running' && cur.status !== 'pending') return { success: true, noop: true }
  const p = cur.progress || {}
  await patchStatus({ status: 'aborted', abort: true, completedAt: db.serverDate(), lastRunSummary: { newAlbums: Number(p.albumsFound || 0), newCandidates: Number(p.candidatesFound || 0), errors: ['用户中止'] } })
  await appendLog('任务已中止')
  return { success: true }
}
