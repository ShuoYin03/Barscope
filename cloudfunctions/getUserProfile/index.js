const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const FOLLOWS_COL = 'follows'

const BADGE_DEFS = [
  { id: 'first_review', name: '首条乐评', icon: '✎', metric: 'reviewCount', target: 1, desc: '发布第一条乐评' },
  { id: 'ten_reviews', name: '十条乐评', icon: '✎✎', metric: 'reviewCount', target: 10, desc: '累计发布 10 条乐评' },
  { id: 'fifty_reviews', name: '资深乐评人', icon: '★', metric: 'reviewCount', target: 50, desc: '累计发布 50 条乐评' },
  { id: 'ten_likes', name: '获赞新星', icon: '♥', metric: 'likesReceived', target: 10, desc: '乐评累计获得 10 个赞' },
  { id: 'fifty_likes', name: '获赞达人', icon: '♥♥', metric: 'likesReceived', target: 50, desc: '乐评累计获得 50 个赞' },
  { id: 'ten_followers', name: '人气乐评人', icon: '⌁', metric: 'followerCount', target: 10, desc: '吸引 10 位关注者' },
]
// Returns every badge (locked and earned) with progress, so the client can render a full gallery
// as well as just the earned subset.
function computeBadges(stats) {
  return BADGE_DEFS.map(b => {
    const current = Math.min(Number(stats[b.metric] || 0), b.target)
    return { id: b.id, name: b.name, icon: b.icon, desc: b.desc, target: b.target, current, earned: current >= b.target }
  })
}

function followDocId(followerOpenId, followingOpenId) {
  return `${followerOpenId}_${followingOpenId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const targetOpenId = String(event.openId || '')
  if (!targetOpenId) return { success: false, error: '缺少用户 ID' }

  try {
    const userRes = await db.collection('users').where({ openId: targetOpenId }).limit(1).get()
    if (!userRes.data.length) return { success: false, error: '用户不存在' }
    const user = userRes.data[0]

    const [{ reviewCount, likesReceived }, latestReviews, followerCount, followingCount, isFollowing] = await Promise.all([
      getReviewAggregate(targetOpenId),
      getLatestReviews(targetOpenId),
      countFollows({ followingOpenId: targetOpenId }),
      countFollows({ followerOpenId: targetOpenId }),
      OPENID && OPENID !== targetOpenId ? isFollowingUser(OPENID, targetOpenId) : Promise.resolve(false),
    ])

    return {
      success: true,
      profile: {
        openId: targetOpenId,
        nickName: user.nickName || '匿名用户',
        avatarUrl: user.avatarUrl || '',
        coverUrl: user.coverUrl || '',
        bio: user.bio || '',
        type: user.type || 'normal',
        reviewCount,
        likesReceived,
        followerCount,
        followingCount,
        isFollowing,
        isMe: OPENID === targetOpenId,
        latestReviews,
        badges: computeBadges({ reviewCount, likesReceived, followerCount }),
      },
    }
  } catch (err) {
    console.error('getUserProfile failed:', err)
    return { success: false, error: err.message }
  }
}

async function getReviewAggregate(openId) {
  let rows = []
  let skip = 0
  while (true) {
    const page = await db.collection('reviews').where({ authorOpenId: openId }).field({ likes: true }).skip(skip).limit(100).get()
    rows = rows.concat(page.data || [])
    if (!page.data || page.data.length < 100) break
    skip += 100
  }
  const likesReceived = rows.reduce((sum, r) => sum + (Number(r.likes) || 0), 0)
  return { reviewCount: rows.length, likesReceived }
}

async function getLatestReviews(openId) {
  const res = await db.collection('reviews').where({ authorOpenId: openId }).orderBy('createdAt', 'desc').limit(10).get()
  return (res.data || []).map(r => ({
    _id: r._id,
    albumId: r.albumId || '',
    albumTitle: r.albumTitle || r.albumId || '',
    rating: r.rating || 0,
    content: r.content || '',
    likes: r.likes || 0,
    timeAgo: formatTimeAgo(r.createdAt),
  }))
}

async function countFollows(where) {
  try {
    await ensureCollection(FOLLOWS_COL)
    const r = await db.collection(FOLLOWS_COL).where(where).count()
    return Number(r.total || 0)
  } catch (e) {
    if (isCollectionMissing(e)) return 0
    throw e
  }
}

async function isFollowingUser(followerOpenId, targetOpenId) {
  try {
    await ensureCollection(FOLLOWS_COL)
    const doc = await db.collection(FOLLOWS_COL).doc(followDocId(followerOpenId, targetOpenId)).get().catch(() => ({ data: null }))
    return !!(doc && doc.data)
  } catch (e) {
    if (isCollectionMissing(e)) return false
    throw e
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

function formatTimeAgo(date) {
  if (!date) return ''
  const diff = Date.now() - new Date(date).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return days + '天前'
  if (days < 30) return Math.floor(days / 7) + '周前'
  return Math.floor(days / 30) + '个月前'
}
