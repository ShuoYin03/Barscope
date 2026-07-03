const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function likeDocId(reviewId, openId) {
  return `${String(reviewId)}_${String(openId)}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const reviewId = event.reviewId
  if (!reviewId) return { success: false, error: 'reviewId required' }
  if (!OPENID) return { success: false, error: 'login required' }

  const likeId = likeDocId(reviewId, OPENID)
  try {
    // A fixed document id means one user can only own one like record per review.
    const existing = await db.collection('review_likes').doc(likeId).get().catch(() => ({ data: null }))
    if (existing && existing.data) return { success: true, liked: true, alreadyLiked: true }

    await db.collection('review_likes').doc(likeId).set({
      data: { reviewId, openId: OPENID, createdAt: db.serverDate() },
    })
    await db.collection('reviews').doc(reviewId).update({ data: { likes: _.inc(1) } })
    return { success: true, liked: true, alreadyLiked: false }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
