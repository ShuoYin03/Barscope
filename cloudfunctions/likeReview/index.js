const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function likeDocId(reviewId, openId) {
  // CloudBase document ids allow letters, digits, underscores and hyphens.
  // Both values already use that character set; trim only as a final safeguard.
  return `${String(reviewId)}_${String(openId)}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const reviewId = event.reviewId
  if (!reviewId) return { success: false, error: 'reviewId required' }
  if (!OPENID) return { success: false, error: 'login required' }

  const likeId = likeDocId(reviewId, OPENID)
  const likeRef = db.collection('review_likes').doc(likeId)
  const reviewRef = db.collection('reviews').doc(reviewId)

  try {
    const result = await db.runTransaction(async transaction => {
      const existing = await transaction.get(likeRef)
      if (existing.data && existing.data.length) return { alreadyLiked: true }

      transaction.set(likeRef, {
        reviewId,
        openId: OPENID,
        createdAt: db.serverDate(),
      })
      transaction.update(reviewRef, { likes: _.inc(1) })
      return { alreadyLiked: false }
    })

    return { success: true, liked: true, alreadyLiked: !!result.alreadyLiked }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
