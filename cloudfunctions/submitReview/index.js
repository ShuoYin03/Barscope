const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { albumId, albumTitle, rating, content } = event

  if (!albumId || !rating || !content) {
    return { success: false, error: '参数不完整' }
  }
  if (rating < 1 || rating > 5) {
    return { success: false, error: '评分范围 1-5' }
  }

  try {
    // Get user
    const { data: users } = await db.collection('users').where({ openId: OPENID }).get()
    if (users.length === 0) {
      return { success: false, error: '请先登录' }
    }
    const user = users[0]

    // Check duplicate
    const { data: existing } = await db.collection('reviews')
      .where({ albumId, userId: OPENID })
      .get()
    if (existing.length > 0) {
      return { success: false, error: '你已经评论过这张专辑了' }
    }

    // Add review
    await db.collection('reviews').add({
      data: {
        albumId,
        albumTitle:    albumTitle || '',
        userId: OPENID,
        userType: user.type,
        userNickName: user.nickName,
        userAvatarUrl: user.avatarUrl || '',
        rating,
        content: content.trim(),
        likes: 0,
        isPinned: user.type === 'critic',
        createdAt: db.serverDate(),
      },
    })

    // Recalculate album avg score
    const { data: allReviews } = await db.collection('reviews')
      .where({ albumId })
      .field({ rating: true })
      .get()

    const sum = allReviews.reduce(function(acc, r) { return acc + (r.rating || 0) }, 0) + rating
    const count = allReviews.length + 1
    const avgScore = Math.round(sum / count * 10) / 10

    await db.collection('albums').doc(albumId).update({
      data: { avgScore, reviewCount: count },
    })

    // Increment user review count
    await db.collection('users').where({ openId: OPENID }).update({
      data: { reviewCount: _.inc(1) },
    })

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
