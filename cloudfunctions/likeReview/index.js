const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const reviewId = event.reviewId
  if (!reviewId) return { success: false, error: 'reviewId required' }
  if (!OPENID) return { success: false, error: 'login required' }

  try {
    const existing = await db.collection('review_likes').where({ reviewId, openId: OPENID }).limit(1).get()
    if (existing.data.length) return { success: true, alreadyLiked: true, liked: true }

    await db.collection('review_likes').add({ data: { reviewId, openId: OPENID, createdAt: db.serverDate() } })
    await db.collection('reviews').doc(reviewId).update({ data: { likes: _.inc(1) } })
    return { success: true, alreadyLiked: false, liked: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
