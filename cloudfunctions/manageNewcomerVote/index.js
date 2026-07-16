const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const BALLOT_COL = 'newcomer_2026_ballots'
const NOMINEE_COL = 'newcomer_2026_nominees'
const MAX_ENTRIES = 3
const DEBUT_YEAR = 2026
const ELIGIBLE_TYPES = new Set(['LP', 'Mixtape'])
// Voting window: 2026-01-01 through 2026-12-31 (China Standard Time).
const DEADLINE = new Date('2027-01-01T00:00:00+08:00')

// Same lightweight substring profanity gate as manageTop10Vote — short optional note, no
// minimum length requirement.
const BAD_WORDS = [
  '傻逼', '傻屄', '煞笔', '沙比', '傻比', 'sb', '智障', '脑残', '弱智', '废物', '人渣', '畜生', '杂种',
  '婊子', '妓女', '贱人', '贱货', '狗娘养的', '死全家', '去死吧', '滚你妈',
  '妈的', '他妈的', 'tmd', 'cnm', 'nmsl', '操你妈', '日你妈', '草你妈', '我操', '我艹',
  'fuck', 'fucker', 'fucking', 'bitch', 'asshole', 'cunt', 'nigger', 'retard',
]
function normalizeForFilter(text) { return String(text || '').toLowerCase().replace(/[\s.,!?~*_\-·、。！？，]/g, '') }
const NORMALIZED_BAD_WORDS = BAD_WORDS.map(normalizeForFilter)
function hasBadWord(text) { const n = normalizeForFilter(text); return NORMALIZED_BAD_WORDS.some(w => w && n.includes(w)) }

function isVotingOpen() { return Date.now() < DEADLINE.getTime() }

exports.main = async event => {
  const action = event.action || 'get_mine'
  if (action === 'get_mine') return await getMine()
  if (action === 'submit') return await submit(event.entries || [])
  if (action === 'list_public') return await listPublic(event.page || 1, event.pageSize || 20)
  if (action === 'stats') return await stats()
  if (action === 'list_nominees') return await listNominees()
  if (action === 'rebuild_nominees') return await rebuildNominees()
  return { success: false, error: 'unknown action' }
}

async function getMine() {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, error: '请先登录' }
  try {
    const r = await db.collection(BALLOT_COL).where({ openId: OPENID }).limit(1).get()
    const doc = (r.data || [])[0] || null
    return { success: true, entries: doc ? doc.entries || [] : [], updatedAt: doc ? doc.updatedAt : null, votingOpen: isVotingOpen() }
  } catch (e) {
    if (isCollectionMissing(e)) return { success: true, entries: [], updatedAt: null, votingOpen: isVotingOpen() }
    return { success: false, error: e.message }
  }
}

async function submit(rawEntries) {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, error: '请先登录' }
  if (!isVotingOpen()) return { success: false, error: '2026 年度最佳新人投票已截止' }

  const list = (Array.isArray(rawEntries) ? rawEntries : []).slice(0, MAX_ENTRIES)
  const seenIds = new Set()
  for (const raw of list) {
    const artistId = String(raw && raw.artistId || '').trim()
    if (!artistId) return { success: false, error: '存在无效的选择' }
    if (seenIds.has(artistId)) return { success: false, error: '同一位新人不能重复选择' }
    seenIds.add(artistId)
    const note = String(raw && raw.note || '').trim().slice(0, 200)
    if (note && hasBadWord(note)) return { success: false, error: '理由包含不当用语，请修改后重新提交' }
  }

  const { data: users } = await db.collection('users').where({ openId: OPENID }).limit(1).get()
  if (!users.length) return { success: false, error: '请先登录' }
  const user = users[0]

  await ensureCollection(BALLOT_COL)

  const entries = []
  for (const raw of list) {
    const artistId = String(raw.artistId).trim()
    const note = String(raw.note || '').trim().slice(0, 200)
    const nomineeRes = await db.collection(NOMINEE_COL).where({ artistId }).limit(1).get()
    const nominee = (nomineeRes.data || [])[0]
    if (!nominee) return { success: false, error: `不在候选名单中：${artistId}` }
    entries.push({
      artistId,
      artistName: String(nominee.artistName || ''),
      avatarUrl: String(nominee.avatarUrl || ''),
      note,
    })
  }

  const existing = await db.collection(BALLOT_COL).where({ openId: OPENID }).limit(1).get()
  const data = {
    openId: OPENID,
    userNickName: user.nickName || '匿名用户',
    userAvatarUrl: user.avatarUrl || '',
    entries,
    updatedAt: db.serverDate(),
  }
  if (existing.data.length) {
    await db.collection(BALLOT_COL).doc(existing.data[0]._id).update({ data })
  } else {
    await db.collection(BALLOT_COL).add({ data: { ...data, createdAt: db.serverDate() } })
  }
  return { success: true, entries }
}

async function listPublic(page, pageSize) {
  try {
    const query = db.collection(BALLOT_COL).where({ entries: db.command.exists(true) })
    const total = Number((await query.count()).total || 0)
    const start = (page - 1) * pageSize
    const result = await query.orderBy('updatedAt', 'desc').skip(start).limit(pageSize).get()
    const list = (result.data || []).filter(d => Array.isArray(d.entries) && d.entries.length > 0)
    return { success: true, list, total, page, pageSize }
  } catch (e) {
    if (isCollectionMissing(e)) return { success: true, list: [], total: 0, page, pageSize }
    return { success: false, error: e.message }
  }
}

async function stats() {
  try {
    const r = await db.collection(BALLOT_COL).where({ entries: db.command.exists(true) }).count()
    return { success: true, total: r.total || 0, votingOpen: isVotingOpen() }
  } catch (e) {
    if (isCollectionMissing(e)) return { success: true, total: 0, votingOpen: isVotingOpen() }
    return { success: false, error: e.message }
  }
}

async function listNominees() {
  try {
    const all = []
    let skip = 0
    while (true) {
      const r = await db.collection(NOMINEE_COL).skip(skip).limit(100).get()
      all.push(...(r.data || []))
      if (!r.data || r.data.length < 100) break
      skip += 100
    }
    return { success: true, list: all }
  } catch (e) {
    if (isCollectionMissing(e)) return { success: true, list: [] }
    return { success: false, error: e.message }
  }
}

async function isAdmin(openId) {
  if (!openId) return false
  const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
  return r.data.length > 0
}

// Owner-resolution fallback chain mirrors getAlbums' artistId query: ownerArtistIds (modern) ->
// artistIds (legacy participants) -> neteaseArtistId (oldest docs, single-artist only).
function resolveOwners(a) {
  if (Array.isArray(a.ownerArtistIds) && a.ownerArtistIds.length) return a.ownerArtistIds.map(String)
  if (Array.isArray(a.artistIds) && a.artistIds.length) return a.artistIds.map(String)
  if (a.neteaseArtistId) return [String(a.neteaseArtistId)]
  return []
}

async function fetchAllApprovedAlbumsForScan() {
  const pageSize = 1000
  let all = []
  let skip = 0
  while (true) {
    const r = await db.collection('albums').where({ approved: true })
      .field({ _id: true, ownerArtistIds: true, neteaseArtistId: true, artistIds: true, releaseYear: true, releaseDate: true, releaseType: true, title: true })
      .skip(skip).limit(pageSize).get()
    all = all.concat(r.data || [])
    if (!r.data || r.data.length < pageSize) break
    skip += pageSize
  }
  return all
}

// Rebuilds the cached "2026 debut artist" nominee list: for every approved artist, find their
// earliest release (by year, then by date within that year) across the whole catalog. If that
// earliest release lands in 2026 and is tagged LP or Mixtape, they're a nominee. Full-collection
// scan (mirrors cleanupDuplicates' fetchAllApprovedAlbums) — admin-triggered, not run per request.
async function rebuildNominees() {
  const { OPENID } = cloud.getWXContext()
  if (!(await isAdmin(OPENID))) return { success: false, error: 'unauthorized' }

  // Only LP/Mixtape releases count as a "project" here — an artist's earlier Beat Tape or Live
  // release doesn't disqualify them; what matters is when their first LP/Mixtape landed.
  const albums = await fetchAllApprovedAlbumsForScan()
  const earliestProjectByArtist = new Map()
  albums.forEach(a => {
    if (!ELIGIBLE_TYPES.has(String(a.releaseType || ''))) return
    const year = Number(a.releaseYear) || 0
    if (!year) return
    const dateKey = String(a.releaseDate || `${year}-13-01`)
    resolveOwners(a).forEach(artistId => {
      const cur = earliestProjectByArtist.get(artistId)
      if (!cur || year < cur.year || (year === cur.year && dateKey < cur.dateKey)) {
        earliestProjectByArtist.set(artistId, { year, dateKey, album: a })
      }
    })
  })

  const debuts = []
  earliestProjectByArtist.forEach((v, artistId) => {
    if (v.year === DEBUT_YEAR) debuts.push({ artistId, album: v.album })
  })

  const artistRes = await db.collection('artist_candidates').where({ status: 'approved' })
    .field({ artistId: true, artistName: true, avatarUrl: true, picUrl: true }).limit(1000).get()
  const artistMap = new Map((artistRes.data || []).map(a => [String(a.artistId), a]))

  const nominees = debuts.map(x => {
    const artist = artistMap.get(String(x.artistId))
    if (!artist) return null
    return {
      artistId: String(x.artistId),
      artistName: String(artist.artistName || ''),
      avatarUrl: String(artist.avatarUrl || artist.picUrl || ''),
      debutAlbumId: x.album._id,
      debutTitle: String(x.album.title || ''),
      debutReleaseType: String(x.album.releaseType || ''),
    }
  }).filter(Boolean)

  await ensureCollection(NOMINEE_COL)
  const existing = await db.collection(NOMINEE_COL).limit(1000).field({ _id: true }).get()
  await Promise.allSettled((existing.data || []).map(d => db.collection(NOMINEE_COL).doc(d._id).remove()))
  for (let i = 0; i < nominees.length; i += 50) {
    await Promise.allSettled(nominees.slice(i, i + 50).map(n => db.collection(NOMINEE_COL).add({ data: n })))
  }
  return { success: true, count: nominees.length }
}

async function ensureCollection(name) {
  try { await db.collection(name).limit(1).get() }
  catch (e) {
    if (!isCollectionMissing(e)) throw e
    try { await db.createCollection(name) } catch (x) {
      if (!String(x && (x.errMsg || x.message) || '').includes('already exists')) throw x
    }
  }
}

function isCollectionMissing(e) {
  const msg = String(e && (e.errMsg || e.message) || '')
  return msg.includes('DATABASE_COLLECTION_NOT_EXIST') || msg.includes('collection not exists') || msg.includes('Db or Table not exist')
}
