const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db    = cloud.database()
const _     = db.command
const https = require('https')

// ── 网易云爬取辅助 ─────────────────────────────────────────────────────────────

const SKIP_KEYWORDS = [
  '第一期','第二期','第三期','第四期','第五期',
  '第六期','第七期','第八期','第九期','第十期',
  '精选集','合辑','现场版','Live','OST','原声',
  '巅峰对决','新说唱','中国有嘻哈','说唱新世代',
]

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

async function fetchNeteaseAlbums(artistId) {
  const albums = []
  let offset   = 0
  while (true) {
    let data
    try { data = await httpsGet(`https://music.163.com/api/artist/albums/${artistId}?limit=50&offset=${offset}`) }
    catch { break }
    if (!data || data.code !== 200) break
    const batch = data.hotAlbums || []
    albums.push(...batch)
    if (!data.more || batch.length === 0) break
    offset += 50
    await new Promise(r => setTimeout(r, 300))
  }
  return albums
}

function normalizeAlbum(raw, fallbackArtist) {
  const primaryArtist    = ((raw.artist || {}).name || '').trim() || fallbackArtist
  const neteaseArtistId  = (raw.artist && raw.artist.id) ? String(raw.artist.id) : null
  const allArtists       = (raw.artists || []).map(a => (a.name || '').trim()).filter(Boolean)
  const artist           = allArtists.length > 1 ? allArtists.join(' / ') : primaryArtist
  const cover            = raw.picUrl || raw.blurPicUrl || ''
  const year             = raw.publishTime ? new Date(raw.publishTime).getFullYear() : 0
  const id               = String(raw.id || '')
  const trackCount       = Number(raw.size || 0)
  const now              = new Date().getFullYear()

  if (!primaryArtist || !cover)                        return null
  if (!(raw.name || '').trim())                        return null
  if (year < 1990 || year > now + 1)                   return null
  if (SKIP_KEYWORDS.some(kw => raw.name.includes(kw))) return null
  if (trackCount > 0 && trackCount < 3)                return null

  return { title: raw.name.trim(), artist, primaryArtist, neteaseArtistId, releaseYear: year, coverUrl: cover, genres: [], sourceId: id, source: 'netease', avgScore: 0, reviewCount: 0, trackCount }
}

async function upsertAlbumsForArtist(artistId, artistName, approved = true) {
  const raw        = await fetchNeteaseAlbums(artistId)
  const normalized = raw.map(r => normalizeAlbum(r, artistName)).filter(Boolean)
  if (!normalized.length) {
    return { fetched: raw.length, normalized: 0, existing: 0, inserted: 0 }
  }

  const sourceIds = normalized.map(a => a.sourceId).filter(Boolean).slice(0, 100)
  const existing  = await db.collection('albums')
    .where({ sourceId: _.in(sourceIds) })
    .field({ _id: true, sourceId: true, neteaseArtistId: true, primaryArtist: true, trackCount: true })
    .limit(sourceIds.length)
    .get()

  const existMap = new Map(existing.data.map(d => [d.sourceId, d]))

  // 回填历史专辑缺失的 neteaseArtistId / primaryArtist
  const needsBackfill = normalized.filter(a => {
    const ex = existMap.get(a.sourceId)
    return ex && (!ex.neteaseArtistId || !ex.primaryArtist || (!ex.trackCount && a.trackCount))
  })
  if (needsBackfill.length) {
    await Promise.allSettled(
      needsBackfill.map(a => {
        const ex = existMap.get(a.sourceId)
        const patch = {}
        if (!ex.neteaseArtistId && a.neteaseArtistId) patch.neteaseArtistId = a.neteaseArtistId
        if (!ex.primaryArtist   && a.primaryArtist)   patch.primaryArtist   = a.primaryArtist
        if (!ex.trackCount      && a.trackCount)       patch.trackCount      = a.trackCount
        return db.collection('albums').doc(ex._id).update({ data: patch })
      })
    )
  }

  const toInsert  = normalized.filter(a => !existMap.has(a.sourceId))
  const results   = await Promise.allSettled(toInsert.map(a => db.collection('albums').add({ data: { ...a, approved } })))
  const inserted  = results.filter(r => r.status === 'fulfilled').length
  return { fetched: raw.length, normalized: normalized.length, existing: existMap.size, inserted }
}

/**
 * 艺人候选管理云函数
 *
 * actions:
 *   upsert_candidates  — 批量写入候选（爬虫 pipeline 调用，无需登录）
 *   list               — 按 status 分页查询（admin）
 *   decide             — 批量审核（approve / decline）（admin）
 *   get_decisions      — 返回所有已决定的候选，供本地 rappers.json 同步
 *   check_admin        — 检查当前用户是否 admin
 *   stats              — 各 status 计数
 */
exports.main = async (event, context) => {
  const action = event.action
  const { OPENID: openId } = cloud.getWXContext()  // 从 pipeline 调用时为 undefined

  // ── 不需要鉴权的动作 ───────────────────────────────────────────────────────
  if (action === 'upsert_candidates') return await upsertCandidates(event.candidates || [])
  if (action === 'get_decisions')     return await getDecisions()
  if (action === 'check_admin')       return { isAdmin: await checkAdmin(openId) }

  // ── 需要 admin 鉴权的动作 ──────────────────────────────────────────────────
  if (!openId || !(await checkAdmin(openId))) {
    return { success: false, error: 'unauthorized' }
  }

  if (action === 'list')                  return await listCandidates(event.status, event.page || 1, event.pageSize || 30, event.keyword || '')
  if (action === 'decide')               return await decide(event.decisions || [])
  if (action === 'stats')                return await stats()
  if (action === 'refresh_albums')       return await refreshAlbums(event.candidateId)
  if (action === 'list_admin_albums')    return await listAdminAlbums(event.artistId, event.artistName)
  if (action === 'toggle_album_approved') return await toggleAlbumApproved(event.albumId, !!event.approved)
  if (action === 'cleanup_singles')      return await cleanupSingles()

  return { success: false, error: 'unknown action' }
}

// ── admin 鉴权 ────────────────────────────────────────────────────────────────
async function checkAdmin(openId) {
  if (!openId) return false
  try {
    const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
    return r.data.length > 0
  } catch (e) {
    return false
  }
}

// ── upsert_candidates ─────────────────────────────────────────────────────────
// candidates: [{name, id, picUrl, albumSize, foundFrom, fromAlbum, round, status}]
async function upsertCandidates(candidates) {
  if (!candidates.length) return { inserted: 0, skipped: 0 }

  const artistIds = candidates.map(c => c.id).filter(Boolean)

  // 分批查已存在的（_.in 每批最多 100）
  const existSet = new Set()
  const chunkSize = 100
  for (var i = 0; i < artistIds.length; i += chunkSize) {
    const chunk = artistIds.slice(i, i + chunkSize)
    try {
      const r = await db.collection('artist_candidates')
        .where({ artistId: _.in(chunk) })
        .field({ _id: true, artistId: true })
        .limit(chunk.length)
        .get()
      r.data.forEach(function(d) { existSet.add(d.artistId) })
    } catch (e) {
      // 集合尚不存在，忽略（所有记录都是新的）
    }
  }

  const toInsert = candidates.filter(c => c.id && !existSet.has(c.id))
  const now = db.serverDate()

  // 分批写入（每批 50 并发，避免超时）
  var totalInserted = 0
  var totalErrors   = 0
  const writeBatch  = 50
  for (var j = 0; j < toInsert.length; j += writeBatch) {
    const batch = toInsert.slice(j, j + writeBatch)
    const ops = batch.map(c => db.collection('artist_candidates').add({
      data: {
        artistId:   c.id,
        artistName: c.name,
        picUrl:     c.picUrl     || '',
        albumSize:  c.albumSize  || 0,
        fansSize:   c.fansSize   || 0,
        foundFrom:  c.foundFrom  || '',
        fromAlbum:  c.fromAlbum  || '',
        round:      c.round      || 0,
        status:     'pending',
        addedAt:    now,
        decidedAt:  null,
      }
    }))
    const results = await Promise.allSettled(ops)
    totalInserted += results.filter(r => r.status === 'fulfilled').length
    totalErrors   += results.filter(r => r.status === 'rejected').length
  }

  return {
    inserted: totalInserted,
    skipped:  existSet.size,
    errors:   totalErrors,
  }
}

// ── list ──────────────────────────────────────────────────────────────────────
async function listCandidates(status, page, pageSize, keyword) {
  try {
    const conditions = {}
    if (status) conditions.status = status
    if (keyword && keyword.trim()) {
      conditions.artistName = db.RegExp({ regexp: keyword.trim(), options: 'i' })
    }
    const q = db.collection('artist_candidates').where(conditions)

    const countResult = await q.count()
    const total = countResult.total

    const listResult = await q
      .orderBy('round', 'asc')
      .orderBy('fansSize', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get()

    return { success: true, list: listResult.data, total, page, pageSize }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// ── list_admin_albums ─────────────────────────────────────────────────────────
async function listAdminAlbums(artistId, artistName) {
  try {
    const escapedName = artistName ? artistName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''
    const [r1, r2, r3] = await Promise.all([
      artistId
        ? db.collection('albums').where({ neteaseArtistId: String(artistId) }).orderBy('releaseYear', 'desc').limit(200).get()
        : Promise.resolve({ data: [] }),
      artistName
        ? db.collection('albums').where({ primaryArtist: artistName }).orderBy('releaseYear', 'desc').limit(200).get()
        : Promise.resolve({ data: [] }),
      escapedName
        ? db.collection('albums').where({ artist: db.RegExp({ regexp: escapedName, options: 'i' }) }).orderBy('releaseYear', 'desc').limit(200).get()
        : Promise.resolve({ data: [] }),
    ])
    const seen = {}
    const merged = []
    r1.data.concat(r2.data).concat(r3.data).forEach(function(a) {
      if (!seen[a._id]) { seen[a._id] = true; merged.push(a) }
    })
    merged.sort(function(a, b) { return (b.releaseYear || 0) - (a.releaseYear || 0) })
    return { success: true, list: merged, total: merged.length }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// ── toggle_album_approved ─────────────────────────────────────────────────────
async function toggleAlbumApproved(albumId, approved) {
  try {
    await db.collection('albums').doc(albumId).update({ data: { approved } })
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// ── decide ────────────────────────────────────────────────────────────────────
// decisions: [{id: _id, decision: 'approved'|'declined'}]
async function decide(decisions) {
  if (!decisions.length) return { success: true, updated: 0 }
  const now = db.serverDate()

  // Fetch candidate docs first to get artistName for album sync
  const fetches = await Promise.allSettled(
    decisions.map(d => db.collection('artist_candidates').doc(d.id).get())
  )

  // Update artist_candidates status
  const candidateOps = decisions.map(d =>
    db.collection('artist_candidates').doc(d.id).update({
      data: { status: d.decision, decidedAt: now }
    })
  )

  // Sync approved field on existing albums + fetch new ones for approved artists
  const albumOps = decisions.map(async (d, i) => {
    const fetch = fetches[i]
    if (fetch.status !== 'fulfilled' || !fetch.value.data) return

    const { artistName, artistId } = fetch.value.data
    const isApproved = d.decision === 'approved'

    // Update approved flag on existing albums — by artistId (reliable) + name fallback for legacy docs
    await Promise.allSettled([
      db.collection('albums').where({ neteaseArtistId: String(artistId) }).update({ data: { approved: isApproved } }),
      db.collection('albums').where({ primaryArtist: artistName }).update({ data: { approved: isApproved } }),
      db.collection('albums').where({ artist: artistName }).update({ data: { approved: isApproved } }),
    ])

    // On approval: fetch & insert the full discography from Netease
    if (isApproved && artistId) {
      await upsertAlbumsForArtist(artistId, artistName)
      try {
        const countRes = await db.collection('albums').where({ neteaseArtistId: String(artistId) }).count()
        await db.collection('artist_candidates').doc(d.id).update({ data: { albumSize: countRes.total } })
      } catch {}
    }
  })

  const results = await Promise.allSettled([...candidateOps, ...albumOps])
  const ok    = results.slice(0, candidateOps.length).filter(r => r.status === 'fulfilled').length
  const fails = results.slice(0, candidateOps.length).filter(r => r.status === 'rejected').length

  return { success: true, updated: ok, errors: fails }
}

// ── get_decisions ─────────────────────────────────────────────────────────────
// 供本地 pipeline sync-decisions 调用
async function getDecisions() {
  try {
    const [approvedRes, declinedRes] = await Promise.all([
      db.collection('artist_candidates')
        .where({ status: 'approved' })
        .field({ artistId: true, artistName: true })
        .limit(500)
        .get(),
      db.collection('artist_candidates')
        .where({ status: 'declined' })
        .field({ artistId: true })
        .limit(500)
        .get(),
    ])

    return {
      success:  true,
      approved: approvedRes.data.map(d => ({ artistId: d.artistId, artistName: d.artistName })),
      declined: declinedRes.data.map(d => ({ artistId: d.artistId })),
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// ── refresh_albums ────────────────────────────────────────────────────────────
async function refreshAlbums(candidateId) {
  if (!candidateId) return { success: false, error: 'missing candidateId' }
  try {
    const res = await db.collection('artist_candidates').doc(candidateId).get()
    const c   = res.data
    if (!c) return { success: false, error: 'not found' }

    const isApproved = c.status === 'approved'
    const stats      = await upsertAlbumsForArtist(c.artistId, c.artistName, isApproved)

    await Promise.allSettled([
      db.collection('albums').where({ neteaseArtistId: String(c.artistId) }).update({ data: { approved: isApproved } }),
      db.collection('albums').where({ primaryArtist: c.artistName }).update({ data: { approved: isApproved } }),
      db.collection('albums').where({ artist: c.artistName }).update({ data: { approved: isApproved } }),
    ])

    try {
      const countRes = await db.collection('albums').where({ neteaseArtistId: String(c.artistId) }).count()
      await db.collection('artist_candidates').doc(candidateId).update({ data: { albumSize: countRes.total } })
    } catch {}

    return { success: true, ...stats }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// ── cleanup_singles ───────────────────────────────────────────────────────────
async function cleanupSingles() {
  try {
    const [r1, r2] = await Promise.all([
      db.collection('albums').where({ trackCount: 1 }).remove(),
      db.collection('albums').where({ trackCount: 2 }).remove(),
    ])
    return { success: true, removed: r1.stats.removed + r2.stats.removed }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// ── stats ─────────────────────────────────────────────────────────────────────
async function stats() {
  try {
    const [p, a, d] = await Promise.all([
      db.collection('artist_candidates').where({ status: 'pending'  }).count(),
      db.collection('artist_candidates').where({ status: 'approved' }).count(),
      db.collection('artist_candidates').where({ status: 'declined' }).count(),
    ])
    return {
      success:  true,
      pending:  p.total,
      approved: a.total,
      declined: d.total,
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}
