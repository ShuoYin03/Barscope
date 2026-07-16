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

const PINYIN_STARTS = [['A','阿'],['B','芭'],['C','嚓'],['D','搭'],['E','蛾'],['F','发'],['G','噶'],['H','哈'],['J','击'],['K','喀'],['L','垃'],['M','妈'],['N','拿'],['O','哦'],['P','啪'],['Q','期'],['R','然'],['S','撒'],['T','塌'],['W','挖'],['X','昔'],['Y','压'],['Z','匝']]
const LETTER_ORDER='ABCDEFGHIJKLMNOPQRSTUVWXYZ#'
function pinyinInitial(ch){ let letter='#'; for(const [initial,startChar] of PINYIN_STARTS){ if(ch.localeCompare(startChar,'zh-Hans-CN-u-co-pinyin')>=0)letter=initial; else break } return letter }
function firstLetter(name){ for(const ch of Array.from(String(name||'').trim())){ if(/[A-Za-z]/.test(ch))return ch.toUpperCase(); if(/[一-鿿]/.test(ch))return pinyinInitial(ch) } return '#' }

function normalizeAlbum(raw, fallbackArtist) {
  const primaryArtist    = ((raw.artist || {}).name || '').trim() || fallbackArtist
  const neteaseArtistId  = (raw.artist && raw.artist.id) ? String(raw.artist.id) : null
  const allArtists       = (raw.artists || []).map(a => (a.name || '').trim()).filter(Boolean)
  const artist           = allArtists.length > 1 ? allArtists.join(' / ') : primaryArtist
  const artistIds        = Array.from(new Set((raw.artists || []).map(a => a && a.id ? String(a.id) : '').filter(Boolean)))
  const cover            = raw.picUrl || raw.blurPicUrl || ''
  const year             = raw.publishTime ? new Date(raw.publishTime).getFullYear() : 0
  const id               = String(raw.id || '')
  const trackCount       = Number(raw.size || 0)
  const now              = new Date().getFullYear()

  if (!primaryArtist || !cover)                        return null
  if (!(raw.name || '').trim())                        return null
  if (year < 1990 || year > now + 1)                   return null
  if (SKIP_KEYWORDS.some(kw => raw.name.includes(kw))) return null
  if (trackCount < 3)                                   return null

  const title = raw.name.trim()
  return { title, artist, primaryArtist, neteaseArtistId, artistIds, releaseYear: year, coverUrl: cover, genres: [], sourceId: id, source: 'netease', avgScore: 0, reviewCount: 0, trackCount, titleLetter: firstLetter(title), isMultiArtist: artistIds.length > 1 }
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
  if (action === 'search_admin_albums')  return await searchAdminAlbums(event.keyword || '')
  if (action === 'toggle_album_approved') return await toggleAlbumApproved(event.albumId, !!event.approved)
  if (action === 'cleanup_singles')      return await cleanupSingles(openId)
  if (action === 'list_all_albums')      return await listAllAlbums(event.letter || '', event.page || 1, event.pageSize || 60)
  if (action === 'album_letter_counts')  return await albumLetterCounts()
  if (action === 'backfill_album_letters') return await backfillAlbumLetters(event.skip || 0)
  if (action === 'list_multi_artist_albums') return await listMultiArtistAlbums(event.page || 1, event.pageSize || 60)
  if (action === 'list_uncategorized_albums') return await listUncategorizedAlbums(event.page || 1, event.pageSize || 60)
  if (action === 'rebuild_multi_artist_index') return await rebuildMultiArtistIndex(event.skip || 0)
  if (action === 'batch_toggle_approved') return await batchToggleApproved(event.ids || [], !!event.approved)
  if (action === 'find_resurrected')     return await findResurrectedAlbums()
  if (action === 'remove_resurrected')   return await removeResurrectedAlbums(event.ids || [])
  if (action === 'set_release_type')     return await setReleaseType(event.albumId, event.releaseType)
  if (action === 'batch_set_release_type') return await batchSetReleaseType(event.ids || [], event.releaseType)
  if (action === 'apply_release_type_rules') return await applyReleaseTypeRules(event.skip || 0)

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
    if (!artistId) return { success: false, error: 'missing artistId' }

    const id = String(artistId)
    const rawAlbums = await fetchNeteaseAlbums(id)

    // 网易云艺人主页返回的专辑 ID 是归属判断的唯一权威来源
    const sourceIds = Array.from(new Set(
      rawAlbums
        .map(raw => normalizeAlbum(raw, artistName || ''))
        .filter(Boolean)
        .map(album => album.sourceId)
        .filter(Boolean)
    ))

    // 网易云请求没有返回数据时，仅按严格 artistId 降级查询
    if (!rawAlbums.length) {
      const fallback = await db.collection('albums')
        .where({ neteaseArtistId: id })
        .orderBy('releaseYear', 'desc')
        .limit(200)
        .get()

      return {
        success: true,
        list: fallback.data,
        total: fallback.data.length,
        source: 'database_fallback',
      }
    }

    const albums = []

    for (let i = 0; i < sourceIds.length; i += 100) {
      const chunk = sourceIds.slice(i, i + 100)
      const result = await db.collection('albums')
        .where({ sourceId: _.in(chunk) })
        .limit(chunk.length)
        .get()

      albums.push(...result.data)
    }

    const seen = new Set()
    const list = albums
      .filter(album => {
        if (seen.has(album._id)) return false
        seen.add(album._id)
        return true
      })
      .sort((a, b) => (b.releaseYear || 0) - (a.releaseYear || 0))

    return {
      success: true,
      list,
      total: list.length,
      source: 'netease',
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// ── search_admin_albums ────────────────────────────────────────────────────────
// Also tries the keyword as a direct _id lookup so admins can paste an album ID
// straight in, not just browse by first letter of the title.
async function searchAdminAlbums(keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return { success: true, list: [], total: 0 }
  try {
    const re = db.RegExp({ regexp: kw, options: 'i' })
    const [byIdRes, regexRes] = await Promise.all([
      db.collection('albums').doc(kw).get().catch(() => null),
      db.collection('albums').where(_.or([{ title: re }, { artist: re }])).orderBy('releaseYear', 'desc').limit(60).get(),
    ])
    const list = []
    const seen = new Set()
    if (byIdRes && byIdRes.data) { list.push(byIdRes.data); seen.add(String(byIdRes.data._id)) }
    ;(regexRes.data || []).forEach(a => { if (!seen.has(String(a._id))) { list.push(a); seen.add(String(a._id)) } })
    return { success: true, list, total: list.length }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// ── list_all_albums / album_letter_counts / backfill_album_letters ──────────────
// Browsing the whole library alphabetically by scanning+sorting at request time
// doesn't scale (that's exactly what timed out the search cloud function — see
// getAlbums). Instead every album carries a precomputed titleLetter (A-Z, # for
// anything not starting with a Latin letter or CJK character), set at write time
// by every place that creates an album doc, so browsing a letter is a cheap
// targeted query instead of a full-collection scan.
async function listAllAlbums(letter, page, pageSize) {
  if (!letter) return { success: false, error: 'missing letter' }
  try {
    const query = db.collection('albums').where({ titleLetter: letter })
    const total = Number((await query.count()).total || 0)
    const start = (page - 1) * pageSize
    const result = await query.orderBy('title', 'asc').skip(start).limit(pageSize).get()
    return { success: true, list: result.data, total, page, pageSize }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// Albums with no releaseType set (either the field never got written, or it was explicitly
// cleared) — surfaced separately so admins can find and tag the backlog without paging through
// the whole letter-sorted library.
async function listUncategorizedAlbums(page, pageSize) {
  try {
    const query = db.collection('albums').where(_.or([{ releaseType: _.exists(false) }, { releaseType: '' }]))
    const total = Number((await query.count()).total || 0)
    const start = (page - 1) * pageSize
    const result = await query.orderBy('title', 'asc').skip(start).limit(pageSize).get()
    return { success: true, list: result.data, total, page, pageSize }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

async function albumLetterCounts() {
  try {
    const counts = await Promise.all(LETTER_ORDER.split('').map(async letter => {
      const total = Number((await db.collection('albums').where({ titleLetter: letter }).count()).total || 0)
      return { letter, total }
    }))
    return { success: true, counts }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// One-time migration for albums created before titleLetter/isMultiArtist existed.
// Idempotent — safe to re-run. Client pages through with `skip` until `done`.
function uniqueIds(value) {
  return Array.from(new Set((Array.isArray(value) ? value : []).map(String).map(x => x.trim()).filter(Boolean)))
}

function splitArtistNames(artist) {
  return Array.from(new Set(String(artist || '').split(/\s*\/\s*|\s*[,&，、+]\s*/).map(x => x.trim()).filter(Boolean)))
}

function isMultiArtistAlbum(album) {
  const owners = uniqueIds(album.ownerArtistIds)
  const participants = uniqueIds(album.artistIds)
  if (owners.length > 1 || participants.length > 1) return true
  return splitArtistNames(album.artist).length > 1
}

async function backfillAlbumLetters(skip) {
  try {
    const pageSize = 300
    const result = await db.collection('albums').skip(skip).limit(pageSize).field({ _id: true, title: true, artist: true, artistIds: true, ownerArtistIds: true }).get()
    const docs = result.data || []
    if (!docs.length) return { success: true, done: true, processed: skip, updated: 0 }
    await Promise.allSettled(docs.map(d => db.collection('albums').doc(d._id).update({ data: { titleLetter: firstLetter(d.title), isMultiArtist: isMultiArtistAlbum(d) } })))
    return { success: true, done: false, processed: skip + docs.length, updated: docs.length, nextSkip: skip + docs.length }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

async function rebuildMultiArtistIndex(skip) {
  try {
    const pageSize = 200
    const result = await db.collection('albums').skip(skip).limit(pageSize).field({ _id: true, artist: true, artistIds: true, ownerArtistIds: true, isMultiArtist: true }).get()
    const docs = result.data || []
    if (!docs.length) {
      const multiTotal = Number((await db.collection('albums').where({ isMultiArtist: true }).count()).total || 0)
      return { success: true, done: true, processed: skip, updated: 0, multiTotal }
    }
    let updated = 0
    const results = await Promise.allSettled(docs.map(d => {
      const next = isMultiArtistAlbum(d)
      if (d.isMultiArtist === next) return Promise.resolve()
      updated++
      return db.collection('albums').doc(d._id).update({ data: { isMultiArtist: next } })
    }))
    const failed = results.filter(r => r.status === 'rejected').length
    return { success: true, done: false, processed: skip + docs.length, updated, failed, nextSkip: skip + docs.length }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// Albums with more than one artistId — surfaced separately so admins can audit
// co-creation attribution without paging through the whole letter-sorted library.
async function listMultiArtistAlbums(page, pageSize) {
  try {
    const query = db.collection('albums').where({ isMultiArtist: true })
    const total = Number((await query.count()).total || 0)
    const start = (page - 1) * pageSize
    const result = await query.orderBy('title', 'asc').skip(start).limit(pageSize).get()
    return { success: true, list: result.data, total, page, pageSize }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

async function batchToggleApproved(ids, approved) {
  const cleanIds = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean).slice(0, 200)
  if (!cleanIds.length) return { success: false, error: 'no ids' }
  const results = await Promise.allSettled(cleanIds.map(id => db.collection('albums').doc(id).update({ data: { approved } })))
  const succeeded = results.filter(r => r.status === 'fulfilled').length
  return { success: true, succeeded, failed: cleanIds.length - succeeded }
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

// ── set_release_type / batch_set_release_type ───────────────────────────────
const RELEASE_TYPES = new Set(['LP', 'Mixtape', 'Live', 'Beat Tape'])

async function setReleaseType(albumId, releaseType) {
  const id = String(albumId || '').trim()
  if (!id) return { success: false, error: 'missing albumId' }
  const type = String(releaseType || '').trim()
  if (type && !RELEASE_TYPES.has(type)) return { success: false, error: 'invalid releaseType' }
  try {
    await db.collection('albums').doc(id).update({ data: { releaseType: type } })
    return { success: true, releaseType: type }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

async function batchSetReleaseType(ids, releaseType) {
  const cleanIds = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean).slice(0, 200)
  if (!cleanIds.length) return { success: false, error: 'no ids' }
  const type = String(releaseType || '').trim()
  if (type && !RELEASE_TYPES.has(type)) return { success: false, error: 'invalid releaseType' }
  const results = await Promise.allSettled(cleanIds.map(id => db.collection('albums').doc(id).update({ data: { releaseType: type } })))
  const succeeded = results.filter(r => r.status === 'fulfilled').length
  return { success: true, succeeded, failed: cleanIds.length - succeeded, releaseType: type }
}

// One-time bulk rule: multi-artist albums -> LP if trackCount>=6 else Mixtape;
// single-artist albums -> LP if trackCount>6 else Mixtape.
// Idempotent — safe to re-run. Client pages through with `skip` until `done`.
async function applyReleaseTypeRules(skip) {
  try {
    const pageSize = 300
    const result = await db.collection('albums').skip(skip).limit(pageSize).field({ _id: true, isMultiArtist: true, trackCount: true, releaseType: true }).get()
    const docs = result.data || []
    if (!docs.length) return { success: true, done: true, processed: skip, updated: 0 }
    let updated = 0
    const results = await Promise.allSettled(docs.map(d => {
      const next = d.isMultiArtist ? (Number(d.trackCount) >= 6 ? 'LP' : 'Mixtape') : (Number(d.trackCount) > 6 ? 'LP' : 'Mixtape')
      if (d.releaseType === next) return Promise.resolve()
      updated++
      return db.collection('albums').doc(d._id).update({ data: { releaseType: next } })
    }))
    const failed = results.filter(r => r.status === 'rejected').length
    return { success: true, done: false, processed: skip + docs.length, updated, failed, nextSkip: skip + docs.length }
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

    // On approval: fetch & insert the full discography from Netease,
    // then sync high-quality avatar + hero image from artist detail API.
    if (isApproved && artistId) {
      await upsertAlbumsForArtist(artistId, artistName)
      try {
        const countRes = await db.collection('albums').where({ neteaseArtistId: String(artistId) }).count()
        await db.collection('artist_candidates').doc(d.id).update({ data: { albumSize: countRes.total } })
      } catch {}
      // Fire-and-forget: sync proper artist avatar + hero image
      cloud.callFunction({ name: 'syncApprovedArtist', data: { artistId: String(artistId) } }).catch(() => {})
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
// Same rationale as manageAlbumCandidates' recordDeletedAlbum: a hard delete with no album_candidates
// trace means a later re-crawl can't tell "never seen before" from "already reviewed and rejected".
async function recordDeletedAlbum(album, reason, openId) {
  if (!album || !album.sourceId) return
  const sourceId = String(album.sourceId)
  const existing = await db.collection('album_candidates').where({ sourceId }).limit(1).get()
  if (existing.data.length) {
    await db.collection('album_candidates').doc(existing.data[0]._id).update({ data: {
      status: 'deleted', decision: 'delete', candidateReason: reason, decidedAt: db.serverDate(), decidedBy: openId || '',
    } })
    return
  }
  const payload = Object.assign({}, album, {
    albumOriginalId: album._id,
    status: 'deleted',
    decision: 'delete',
    candidateReason: reason,
    reportReason: reason,
    addedAt: db.serverDate(),
    decidedAt: db.serverDate(),
    decidedBy: openId || '',
  })
  delete payload._id
  await db.collection('album_candidates').add({ data: payload })
}

async function cleanupSingles(openId) {
  try {
    // Step 1: 把没有 trackCount 字段的记录先回填为 0，让后面的循环统一处理
    await db.collection('albums')
      .where({ trackCount: _.exists(false) })
      .update({ data: { trackCount: 0 } })

    // Step 2: 批量删除 trackCount <= 2（含 0）直到全部清干净。先取出这一批文档留一条
    // album_candidates(status:'deleted') 记录再删——原来是直接 .where().remove()，没有任何
    // sourceId 痕迹，后续重新爬取同一位艺人会把这些单曲当全新专辑重新插回去。
    let totalRemoved = 0
    while (true) {
      const batchRes = await db.collection('albums').where({ trackCount: _.lte(2) }).limit(100).get()
      const rows = batchRes.data || []
      if (!rows.length) break
      await Promise.all(rows.map(album => recordDeletedAlbum(album, `清理专辑库：曲目数 ${album.trackCount || 0} 首`, openId)))
      const ids = rows.map(x => x._id)
      const r = await db.collection('albums').where({ _id: _.in(ids) }).remove()
      totalRemoved += r.stats.removed
    }
    return { success: true, removed: totalRemoved }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

// ── 找回被误重新收录的专辑 ─────────────────────────────────────────────────────
// 一张专辑被判定"不该收录"，无论是人工在候选区删除（status:'deleted'）还是自动质检流程标记后还没人
// 复核（status:'pending'），只要不是 status:'kept'，就说明这个 sourceId 现在不应该出现在 albums 里。
// 只查 'deleted' 会漏掉 rescreenAlbums 那条自动质检流程留下的 'pending' 记录。一次全量重新爬取如果
// 又扫到同一个艺人，会把这个 sourceId 当全新专辑重新插回 albums（cloudCrawler 已经加了拦截，但爬虫
// 上次跑的时候还没有这道检查，已经误加回来的需要手动找出来复核）。
async function findResurrectedAlbums() {
  try {
    const blockedSourceIds = new Set()
    let skip = 0
    while (true) {
      const res = await db.collection('album_candidates').where({ status: _.neq('kept') }).field({ sourceId: true }).skip(skip).limit(1000).get()
      const rows = res.data || []
      rows.forEach(x => { if (x.sourceId) blockedSourceIds.add(String(x.sourceId)) })
      if (rows.length < 1000) break
      skip += 1000
    }
    const ids = Array.from(blockedSourceIds)
    const matches = []
    for (let i = 0; i < ids.length; i += 100) {
      const res = await db.collection('albums').where({ sourceId: _.in(ids.slice(i, i + 100)) })
        .field({ _id: true, title: true, artist: true, sourceId: true, approved: true }).get()
      matches.push(...(res.data || []))
    }
    return { success: true, total: matches.length, list: matches }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

async function removeResurrectedAlbums(ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : []
  if (!list.length) return { success: false, error: '缺少专辑ID列表' }
  let removed = 0
  const errors = []
  for (const id of list) {
    try {
      await Promise.all([
        db.collection('reviews').where({ albumId: id }).remove().catch(() => {}),
        db.collection('favorites').where({ albumId: id }).remove().catch(() => {}),
      ])
      await db.collection('albums').doc(id).remove()
      removed += 1
    } catch (e) {
      errors.push({ id, error: e.message })
    }
  }
  return { success: true, removed, errors }
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
