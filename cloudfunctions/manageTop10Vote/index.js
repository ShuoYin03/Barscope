const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COL = 'top10_2026_ballots'
const MAX_ENTRIES = 10
const VOTE_YEAR = 2026
// Voting window: 2026-01-01 through 2026-12-31 (China Standard Time), so the cutoff is the
// instant Beijing time rolls into 2027.
const DEADLINE = new Date('2027-01-01T00:00:00+08:00')

// Lightweight substring profanity gate for the short, optional "why I picked this" note —
// deliberately no minimum length (unlike submitReview's moderation, which guards long-form
// review text), since a one-line reason or an empty note are both valid here.
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
  return { success: false, error: 'unknown action' }
}

async function getMine() {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, error: '请先登录' }
  try {
    const r = await db.collection(COL).where({ openId: OPENID }).limit(1).get()
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
  if (!isVotingOpen()) return { success: false, error: '2026 十大专辑投票已截止' }

  const list = (Array.isArray(rawEntries) ? rawEntries : []).slice(0, MAX_ENTRIES)
  const seenIds = new Set()
  for (const raw of list) {
    const albumId = String(raw && raw.albumId || '').trim()
    if (!albumId) return { success: false, error: '存在无效的专辑选择' }
    if (seenIds.has(albumId)) return { success: false, error: '同一张专辑不能重复选择' }
    seenIds.add(albumId)
    const note = String(raw && raw.note || '').trim().slice(0, 200)
    if (note && hasBadWord(note)) return { success: false, error: '理由包含不当用语，请修改后重新提交' }
  }

  const { data: users } = await db.collection('users').where({ openId: OPENID }).limit(1).get()
  if (!users.length) return { success: false, error: '请先登录' }
  const user = users[0]

  await ensureCollection(COL)

  const entries = []
  for (const raw of list) {
    const albumId = String(raw.albumId).trim()
    const note = String(raw.note || '').trim().slice(0, 200)
    const album = (await db.collection('albums').doc(albumId).get()).data
    if (!album || !album.approved) return { success: false, error: `专辑不存在或未收录：${albumId}` }
    if (Number(album.releaseYear) !== VOTE_YEAR) return { success: false, error: `《${album.title || albumId}》不是 ${VOTE_YEAR} 年发行的专辑` }
    entries.push({
      albumId,
      title: String(album.title || ''),
      artist: String(album.artist || album.primaryArtist || ''),
      coverUrl: String(album.coverUrl || ''),
      note,
    })
  }

  const existing = await db.collection(COL).where({ openId: OPENID }).limit(1).get()
  const data = {
    openId: OPENID,
    userNickName: user.nickName || '匿名用户',
    userAvatarUrl: user.avatarUrl || '',
    entries,
    updatedAt: db.serverDate(),
  }
  if (existing.data.length) {
    await db.collection(COL).doc(existing.data[0]._id).update({ data })
  } else {
    await db.collection(COL).add({ data: { ...data, createdAt: db.serverDate() } })
  }
  return { success: true, entries }
}

async function listPublic(page, pageSize) {
  try {
    const query = db.collection(COL).where({ entries: db.command.exists(true) })
    const total = Number((await query.count()).total || 0)
    const start = (page - 1) * pageSize
    const result = await query.orderBy('updatedAt', 'desc').skip(start).limit(pageSize).get()
    const list = (result.data || []).filter(d => Array.isArray(d.entries) && d.entries.length > 0)
    await applyLiveProfiles(list)
    return { success: true, list, total, page, pageSize }
  } catch (e) {
    if (isCollectionMissing(e)) return { success: true, list: [], total: 0, page, pageSize }
    return { success: false, error: e.message }
  }
}

// ballots snapshot userAvatarUrl/userNickName at submit time, which goes stale once a user
// changes their profile — pull the live values from users so the community feed stays current.
async function applyLiveProfiles(list) {
  const openIds = Array.from(new Set(list.map(d => d.openId).filter(Boolean)))
  if (!openIds.length) return
  try {
    const usersRes = await db.collection('users').where({ openId: db.command.in(openIds) }).field({ openId: true, nickName: true, avatarUrl: true }).get()
    // some accounts have duplicate users docs sharing one openId (legacy duplicate writes) —
    // merge rather than let whichever doc comes last blindly win, preferring set values.
    const userMap = new Map()
    ;(usersRes.data || []).forEach(u => {
      const key = String(u.openId)
      const prev = userMap.get(key)
      userMap.set(key, prev ? { nickName: u.nickName || prev.nickName, avatarUrl: u.avatarUrl || prev.avatarUrl } : u)
    })
    list.forEach(d => {
      const u = userMap.get(d.openId)
      if (u) { if (u.nickName) d.userNickName = u.nickName; if (u.avatarUrl) d.userAvatarUrl = u.avatarUrl }
    })
  } catch (e) { console.warn('applyLiveProfiles failed:', e.message) }
}

async function stats() {
  try {
    const r = await db.collection(COL).where({ entries: db.command.exists(true) }).count()
    return { success: true, total: r.total || 0, votingOpen: isVotingOpen() }
  } catch (e) {
    if (isCollectionMissing(e)) return { success: true, total: 0, votingOpen: isVotingOpen() }
    return { success: false, error: e.message }
  }
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
