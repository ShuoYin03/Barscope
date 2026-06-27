const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db    = cloud.database()
const _     = db.command
const https = require('https')

const COL = 'crawlerStatus'
const DOC = 'singleton'

// 每段处理多少位艺人 —— 设为 50 以覆盖大多数情况，减少自我续跑次数
const CHUNK = 50

// 仅存在于云端代码，客户端无法获知 → 用于校验「自我续跑」的内部调用，防止伪造绕过 admin
const INTERNAL_TOKEN = 'cc_internal_v1'

const SKIP_KEYWORDS = [
  '第一期','第二期','第三期','第四期','第五期',
  '第六期','第七期','第八期','第九期','第十期',
  '精选集','合辑','现场版','Live','OST','原声',
  '巅峰对决','新说唱','中国有嘻哈','说唱新世代',
]

/**
 * 云端爬虫（无需本地电脑）
 *
 * 直接在云函数里抓网易云 → 入库 albums 集合。复用了 manageCandidates 已验证可行的抓取逻辑。
 *
 * actions（均需 admin；续跑调用带 __internal 标记）:
 *   album       { albumId }   — 精确收录单张专辑（含单曲，跳过过滤）
 *   artist      { artistId }  — 收录指定艺人的全部专辑 + 单曲
 *   allApproved { cursor? }   — 一键爬取所有「已批准」艺人的全部专辑 + 单曲（分段自我续跑）
 *   getStatus                 — 读取运行状态（与 crawlerControl.getStatus 一致）
 */
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action     = event.action
  const internal   = event.__internal === true && event.__token === INTERNAL_TOKEN

  if (action === 'getStatus') {
    let doc
    try { doc = (await db.collection(COL).doc(DOC).get()).data }
    catch { doc = makeDefault() }
    return { success: true, status: doc }
  }

  // 客户端发起的调用需 admin；服务端自我续跑（__internal）放行
  if (!internal && !(await isAdmin(OPENID))) {
    return { success: false, error: '无权限' }
  }

  try {
    if (action === 'album')       return await runAlbum(String(event.albumId || event.param || ''))
    if (action === 'artist')      return await runArtist(String(event.artistId || event.param || ''))
    if (action === 'allApproved') return await runAllApproved(event.cursor || 0)
    return { success: false, error: '未知 action' }
  } catch (err) {
    await appendLog(`出错: ${err.message}`)
    await patchStatus({ status: 'error', completedAt: db.serverDate(),
      lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [err.message] } })
    return { success: false, error: err.message }
  }
}

// ── 模式：按专辑 ID ─────────────────────────────────────────────────────────────
async function runAlbum(albumId) {
  if (!/^\d+$/.test(albumId)) return { success: false, error: '专辑 ID 必须是数字' }

  await patchStatus({
    status: 'running', mode: 'album', param: albumId,
    triggeredAt: db.serverDate(), completedAt: null,
    progress: { totalArtists: 1, processedArtists: 0, albumsFound: 0, candidatesFound: 0 },
  })
  await appendLog(`云端按专辑ID：${albumId}`)

  const raw = await fetchAlbumById(albumId)
  if (!raw) {
    await failStatus(`未找到专辑 ${albumId}`)
    return { success: false, error: '未找到该专辑（或被风控）' }
  }
  // 精确收录：跳过年份/关键词过滤，单曲也要
  const { inserted, total } = await upsertAlbums([raw], '', { skipFilters: true })
  await doneStatus(1, inserted, `专辑《${(raw.name || '').trim()}》新增 ${inserted} 张`)
  return { success: true, inserted, total }
}

// ── 模式：按艺人 ID ─────────────────────────────────────────────────────────────
async function runArtist(artistId) {
  if (!/^\d+$/.test(artistId)) return { success: false, error: '艺人 ID 必须是数字' }

  await patchStatus({
    status: 'running', mode: 'artist', param: artistId,
    triggeredAt: db.serverDate(), completedAt: null,
    progress: { totalArtists: 1, processedArtists: 0, albumsFound: 0, candidatesFound: 0 },
  })
  await appendLog(`云端按艺人ID：${artistId}`)

  const { name, albums } = await fetchArtistAlbums(artistId)
  if (!albums.length) {
    await failStatus(`艺人 ${artistId} 无专辑（或被风控）`)
    return { success: false, error: '未找到专辑（或被风控）' }
  }
  const { inserted, total } = await upsertAlbums(albums, name)
  await doneStatus(1, inserted, `艺人 ${name || artistId} 新增 ${inserted} 张`)
  return { success: true, inserted, total, artistName: name }
}

// ── 模式：全部已批准（分段自我续跑）─────────────────────────────────────────────
async function runAllApproved(cursor) {
  const approvedRes = await db.collection('artist_candidates')
    .where({ status: 'approved' })
    .field({ artistId: true, artistName: true })
    .limit(1000)
    .get()
  const list  = approvedRes.data.filter(d => d.artistId)
  const total = list.length

  if (total === 0) {
    await doneStatus(0, 0, '没有已批准的艺人')
    return { success: true, status: 'done', total: 0 }
  }

  if (cursor === 0) {
    await patchStatus({
      status: 'running', mode: 'allApproved', param: '', abort: false,
      triggeredAt: db.serverDate(), completedAt: null,
      progress: { totalArtists: total, processedArtists: 0, albumsFound: 0, candidatesFound: 0 },
      lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [] },
    })
    await appendLog(`云端全量开始：${total} 位已批准艺人`)
  }

  // 中止检测：用户点了「中止」→ 收尾停止，不再续跑
  if (await isAbortRequested()) {
    const found = await currentAlbumsFound()
    await patchStatus({
      status: 'aborted', abort: false, completedAt: db.serverDate(),
      lastRunSummary: { newAlbums: found, newCandidates: 0, errors: ['用户中止'] },
    })
    await appendLog(`已中止（进度 ${cursor}/${total}，已新增 ${found} 张）`)
    return { success: true, status: 'aborted', processed: cursor, total }
  }

  const slice = list.slice(cursor, cursor + CHUNK)
  let added = 0
  for (let i = 0; i < slice.length; i++) {
    const r = slice[i]
    try {
      const { albums } = await fetchArtistAlbums(r.artistId)
      const { inserted, total } = await upsertAlbums(albums, r.artistName)
      added += inserted
      const countRes = await db.collection('albums').where({ neteaseArtistId: String(r.artistId) }).count()
      await db.collection('artist_candidates').doc(r._id).update({ data: { albumSize: countRes.total } })
      await appendLog(`[${cursor + i + 1}/${list.length}] ${r.artistName}: 网易${albums.length}张 入库${total}张 新增${inserted}张`)
    } catch (e) {
      await appendLog(`[${cursor + i + 1}/${list.length}] ${r.artistName} 失败: ${e.message}`)
    }
  }

  const processed  = Math.min(cursor + CHUNK, total)
  const prevFound  = await currentAlbumsFound()
  const totalFound = prevFound + added
  await patchStatus({ progress: { totalArtists: total, processedArtists: processed, albumsFound: totalFound, candidatesFound: 0 } })
  await appendLog(`进度 ${processed}/${total}，本段新增 ${added} 张`)

  if (processed < total) {
    // 自我续跑下一段：另起一次独立调用，本次返回后它继续运行
    await cloud.callFunction({ name: 'cloudCrawler', data: { action: 'allApproved', cursor: processed, __internal: true, __token: INTERNAL_TOKEN } })
    return { success: true, status: 'running', processed, total }
  }

  await patchStatus({
    status: 'done', completedAt: db.serverDate(),
    lastRunSummary: { newAlbums: totalFound, newCandidates: 0, errors: [] },
  })
  await appendLog(`云端全量完成，共新增 ${totalFound} 张`)

  // 验证 crawlerStatus 文档是否真的写入（用于排查环境问题）
  let _dbCheck = null
  try {
    const s = (await db.collection(COL).doc(DOC).get()).data
    _dbCheck = { ok: true, status: s.status, logCount: (s.log || []).length }
  } catch (e) {
    _dbCheck = { ok: false, error: e.message }
  }
  return { success: true, status: 'done', total, newAlbums: totalFound, _dbCheck }
}

// ── 网易云抓取 ─────────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    'https://music.163.com/',
      },
    }, res => {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', () => { try { resolve(JSON.parse(buf)) } catch { resolve(null) } })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function fetchArtistAlbums(artistId) {
  const albums = []
  let offset = 0
  let name   = ''
  while (true) {
    let data
    try { data = await httpsGet(`https://music.163.com/api/artist/albums/${artistId}?limit=50&offset=${offset}`) }
    catch { break }
    if (!data || data.code !== 200) break
    if (!name) name = ((data.artist || {}).name || '')
    const batch = data.hotAlbums || []
    albums.push(...batch)
    if (!data.more || batch.length === 0) break
    offset += 50
    await sleep(300)
  }
  return { name, albums }
}

// /api/album/{id} 已被风控（code -462），必须用 v1 接口
async function fetchAlbumById(albumId) {
  let data
  try { data = await httpsGet(`https://music.163.com/api/v1/album/${albumId}`) }
  catch { return null }
  if (!data || data.code !== 200) return null
  return data.album || null
}

function normalizeAlbum(raw, fallbackArtist, opts) {
  opts = opts || {}
  const title            = (raw.name || '').trim()
  const primaryArtist    = ((raw.artist || {}).name || '').trim() || fallbackArtist
  const neteaseArtistId  = (raw.artist && raw.artist.id) ? String(raw.artist.id) : null
  const allArtists       = (raw.artists || []).map(a => (a.name || '').trim()).filter(Boolean)
  const artist           = allArtists.length > 1 ? allArtists.join(' / ') : primaryArtist
  const cover            = raw.picUrl || raw.blurPicUrl || ''
  const year             = raw.publishTime ? new Date(raw.publishTime).getFullYear() : 0
  const id               = String(raw.id || '')
  const trackCount       = Number(raw.size || 0)
  const now              = new Date().getFullYear()

  if (!title || !primaryArtist || !cover) return null
  if (!opts.skipFilters) {
    if (year < 1990 || year > now + 1) return null
    if (SKIP_KEYWORDS.some(kw => title.includes(kw))) return null
    if (trackCount < 3) return null
  }
  return {
    title, artist, primaryArtist, neteaseArtistId, releaseYear: year, coverUrl: cover,
    genres: [], sourceId: id, source: 'netease', crawlSource: 'cloud',
    avgScore: 0, reviewCount: 0, trackCount,
  }
}

async function upsertAlbums(rawList, fallbackArtist, opts) {
  const normalized = rawList.map(r => normalizeAlbum(r, fallbackArtist, opts)).filter(Boolean)
  if (!normalized.length) return { inserted: 0, total: 0 }

  // 批量找出已存在的 sourceId（每批 100）
  const sourceIds = normalized.map(a => a.sourceId).filter(Boolean)
  const existMap  = new Map() // sourceId -> { _id, neteaseArtistId, primaryArtist }
  for (let i = 0; i < sourceIds.length; i += 100) {
    const chunk = sourceIds.slice(i, i + 100)
    try {
      const r = await db.collection('albums')
        .where({ sourceId: _.in(chunk) })
        .field({ _id: true, sourceId: true, neteaseArtistId: true, primaryArtist: true, trackCount: true })
        .limit(chunk.length)
        .get()
      r.data.forEach(d => existMap.set(d.sourceId, d))
    } catch (e) { /* 集合不存在则全部视为新 */ }
  }

  // 回填历史专辑缺失的 neteaseArtistId / primaryArtist（一次性，跑完后查询直接命中）
  const needsBackfill = normalized.filter(a => {
    const ex = existMap.get(a.sourceId)
    return ex && (!ex.neteaseArtistId || !ex.primaryArtist || (!ex.trackCount && a.trackCount))
  })
  if (needsBackfill.length) {
    await Promise.allSettled(
      needsBackfill.map(a => {
        const ex = existMap.get(a.sourceId)
        // Backfill reveals this is a single/EP → delete it rather than update
        if (!ex.trackCount && a.trackCount && a.trackCount < 3) {
          return db.collection('albums').doc(ex._id).remove()
        }
        const patch = {}
        if (!ex.neteaseArtistId && a.neteaseArtistId) patch.neteaseArtistId = a.neteaseArtistId
        if (!ex.primaryArtist   && a.primaryArtist)   patch.primaryArtist   = a.primaryArtist
        if (!ex.trackCount      && a.trackCount)       patch.trackCount      = a.trackCount
        return Object.keys(patch).length ? db.collection('albums').doc(ex._id).update({ data: patch }) : Promise.resolve()
      })
    )
  }

  const toInsert = normalized.filter(a => !existMap.has(a.sourceId))
  let inserted = 0
  const BATCH = 40
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH)
    const res = await Promise.allSettled(
      batch.map(a => db.collection('albums').add({ data: Object.assign({ approved: true }, a) }))
    )
    inserted += res.filter(r => r.status === 'fulfilled').length
  }
  return { inserted, total: normalized.length }
}

// ── 状态读写（共用 crawlerStatus.singleton）────────────────────────────────────
async function patchStatus(fields) {
  const res = await db.collection(COL).doc(DOC).update({ data: fields })
  if (res.stats.updated === 0) {
    // 文档不存在（云函数中 update 不抛错，返回 updated:0）→ 用 set 创建
    await db.collection(COL).doc(DOC).set({ data: Object.assign(makeDefault(), fields) })
  }
}

async function appendLog(line) {
  const ts = new Date().toISOString().slice(11, 19)
  const full = `[${ts}] ${line}`
  console.log('[log]', full)
  try {
    await db.collection(COL).doc(DOC).update({
      data: { log: _.push({ each: [full], slice: -50 }) },
    })
  } catch (e) {
    console.warn('[appendLog] failed:', e.message)
  }
}

async function currentAlbumsFound() {
  try {
    const s = (await db.collection(COL).doc(DOC).get()).data
    return (s.progress || {}).albumsFound || 0
  } catch { return 0 }
}

async function isAbortRequested() {
  try {
    const s = (await db.collection(COL).doc(DOC).get()).data
    return !!(s && s.abort)
  } catch { return false }
}

async function doneStatus(totalArtists, inserted, logLine) {
  await patchStatus({
    status: 'done', completedAt: db.serverDate(),
    progress: { totalArtists, processedArtists: totalArtists, albumsFound: inserted, candidatesFound: 0 },
    lastRunSummary: { newAlbums: inserted, newCandidates: 0, errors: [] },
  })
  await appendLog(logLine)
}

async function failStatus(logLine) {
  await appendLog(logLine)
  await patchStatus({
    status: 'error', completedAt: db.serverDate(),
    lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [logLine] },
  })
}

async function isAdmin(openId) {
  if (!openId) return false
  try {
    const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
    return r.data.length > 0
  } catch { return false }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function makeDefault() {
  return {
    status: 'idle', triggeredAt: null, completedAt: null,
    triggerType: 'manual', mode: 'fission', param: '', abort: false,
    progress: { totalArtists: 0, processedArtists: 0, albumsFound: 0, candidatesFound: 0 },
    lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [] },
    schedule: { enabled: false, interval: 'weekly', nextRun: null },
    log: [],
  }
}
