const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

async function safeGet(task) {
  try { return await task() } catch (err) { console.warn('optional review metadata failed:', err.message); return { data: [] } }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { albumId, userId, page = 1, pageSize = 20 } = event
  if (!albumId && !userId && !event.recent) return { success: false, error: 'albumId or userId or recent required' }

  try {
    let records = []
    if (userId) {
      const [newRes, legacyRes] = await Promise.all([
        db.collection('reviews').where({ authorOpenId: userId }).orderBy('createdAt', 'desc').limit(100).get(),
        db.collection('reviews').where({ userId }).orderBy('createdAt', 'desc').limit(100).get(),
      ])
      const seen = new Set()
      records = (newRes.data || []).concat(legacyRes.data || []).filter(r => {
        if (seen.has(r._id)) return false
        seen.add(r._id)
        return true
      }).sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
      records = records.slice((page - 1) * pageSize, page * pageSize)
    } else {
      const skip = (page - 1) * pageSize
      let query
      if (albumId) {
        // Avoid requiring a compound index just to render the review section.
        query = db.collection('reviews').where({ albumId }).orderBy('createdAt', 'desc')
      } else {
        query = db.collection('reviews').orderBy('createdAt', 'desc')
      }
      const result = await query.skip(skip).limit(pageSize).get()
      records = result.data || []
      if (albumId) {
        records.sort((a, b) => {
          const pin = Number(!!b.isPinned) - Number(!!a.isPinned)
          if (pin) return pin
          return (Number(b.likes) || 0) - (Number(a.likes) || 0)
        })
      }
    }

    const reviewIds = records.map(r => r._id)
    const likesRes = OPENID && reviewIds.length
      ? await safeGet(() => db.collection('review_likes').where({ reviewId: _.in(reviewIds), openId: OPENID }).get())
      : { data: [] }
    const repliesRes = reviewIds.length
      ? await safeGet(() => db.collection('review_replies').where({ reviewId: _.in(reviewIds) }).get())
      : { data: [] }

    const liked = new Set((likesRes.data || []).map(x => x.reviewId))
    const replyCounts = {}
    ;(repliesRes.data || []).forEach(x => { replyCounts[x.reviewId] = (replyCounts[x.reviewId] || 0) + 1 })

    const list = records.map(r => ({
      ...r,
      initial: r.userNickName ? r.userNickName[0] : '?',
      userName: r.userNickName || '匿名用户',
      score: String(r.rating || 0),
      timeAgo: formatTimeAgo(r.createdAt),
      likedByMe: liked.has(r._id),
      replyCount: replyCounts[r._id] || r.replyCount || 0,
    }))
    return { success: true, list }
  } catch (err) {
    console.error('getReviews failed:', err)
    return { success: false, error: err.message }
  }
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
