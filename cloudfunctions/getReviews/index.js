const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { albumId, userId, page = 1, pageSize = 20 } = event

  if (!albumId && !userId && !event.recent) {
    return { success: false, error: 'albumId or userId or recent required' }
  }

  try {
    var skip = (page - 1) * pageSize
    var query

    if (albumId) {
      query = db.collection('reviews')
        .where({ albumId })
        .orderBy('isPinned', 'desc')
        .orderBy('likes', 'desc')
        .orderBy('createdAt', 'desc')
    } else if (userId) {
      query = db.collection('reviews')
        .where({ userId })
        .orderBy('createdAt', 'desc')
    } else {
      // recent mode: latest reviews across all albums
      query = db.collection('reviews')
        .orderBy('createdAt', 'desc')
    }

    var result = await query.skip(skip).limit(pageSize).get()

    var list = result.data.map(function(r) {
      return Object.assign({}, r, {
        initial: r.userNickName ? r.userNickName[0] : '?',
        userName: r.userNickName,
        score: '★'.repeat(r.rating || 0),
        timeAgo: formatTimeAgo(r.createdAt),
        replyCount: 0,
      })
    })

    return { success: true, list: list }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function formatTimeAgo(date) {
  if (!date) return ''
  var diff = Date.now() - new Date(date).getTime()
  var days = Math.floor(diff / 86400000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return days + '天前'
  if (days < 30) return Math.floor(days / 7) + '周前'
  return Math.floor(days / 30) + '个月前'
}
