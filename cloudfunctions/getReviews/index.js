const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { albumId, userId, page = 1, pageSize = 20 } = event
  if (!albumId && !userId && !event.recent) return { success: false, error: 'albumId or userId or recent required' }

  try {
    const skip = (page - 1) * pageSize
    let query
    if (albumId) query = db.collection('reviews').where({ albumId }).orderBy('isPinned', 'desc').orderBy('likes', 'desc').orderBy('createdAt', 'desc')
    else if (userId) query = db.collection('reviews').where({ userId }).orderBy('createdAt', 'desc')
    else query = db.collection('reviews').orderBy('createdAt', 'desc')

    const result = await query.skip(skip).limit(pageSize).get()
    const reviewIds = result.data.map(r => r._id)
    const [likesRes, repliesRes] = await Promise.all([
      OPENID && reviewIds.length ? db.collection('review_likes').where({ reviewId: db.command.in(reviewIds), openId: OPENID }).get() : Promise.resolve({ data: [] }),
      reviewIds.length ? db.collection('review_replies').where({ reviewId: db.command.in(reviewIds) }).get() : Promise.resolve({ data: [] }),
    ])
    const liked = new Set((likesRes.data || []).map(x => x.reviewId))
    const replyCounts = {}
    ;(repliesRes.data || []).forEach(x => { replyCounts[x.reviewId] = (replyCounts[x.reviewId] || 0) + 1 })

    const list = result.data.map(r => Object.assign({}, r, {
      initial: r.userNickName ? r.userNickName[0] : '?',
      userName: r.userNickName || '匿名用户',
      score: String(r.rating || 0),
      timeAgo: formatTimeAgo(r.createdAt),
      likedByMe: liked.has(r._id),
      replyCount: replyCounts[r._id] || r.replyCount || 0,
    }))
    return { success: true, list }
  } catch (err) { return { success: false, error: err.message } }
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
