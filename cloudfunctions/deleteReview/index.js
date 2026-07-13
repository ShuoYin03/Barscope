const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const reviewId = String(event.reviewId || '')
  if (!OPENID) return { success: false, error: '请先登录' }
  if (!reviewId) return { success: false, error: '缺少评论 ID' }

  try {
    const reviewRes = await db.collection('reviews').doc(reviewId).get()
    const review = reviewRes.data
    if (!review) return { success: false, error: '评论不存在' }

    // New reviews use authorOpenId; legacy reviews may store the account id in userId.
    const isOwner = review.authorOpenId === OPENID || review.userId === OPENID
    if (!isOwner) return { success: false, error: '无权删除这条评论' }

    const albumId = review.albumId
    await db.collection('reviews').doc(reviewId).remove()

    // Remove associated interaction data. These collections are optional in older environments.
    await Promise.all([
      db.collection('review_likes').where({ reviewId }).remove().catch(() => null),
      db.collection('review_replies').where({ reviewId }).remove().catch(() => null),
    ])

    if (albumId) {
      const remaining = await db.collection('reviews').where({ albumId }).field({ rating: true }).limit(100).get()
      const rows = remaining.data || []
      const sum = rows.reduce((total, item) => total + (Number(item.rating) || 0), 0)
      const count = rows.length
      await db.collection('albums').doc(albumId).update({
        data: {
          avgScore: count ? Math.round((sum / count) * 10) / 10 : 0,
          reviewCount: count,
        },
      }).catch(() => null)
    }

    const [newReviews, legacyReviews] = await Promise.all([
      db.collection('reviews').where({ authorOpenId: OPENID }).field({ _id: true }).limit(100).get(),
      db.collection('reviews').where({ userId: OPENID }).field({ _id: true }).limit(100).get(),
    ])
    const ownReviewIds = new Set([...(newReviews.data || []), ...(legacyReviews.data || [])].map(item => item._id))
    await db.collection('users').where({ openId: OPENID }).update({
      data: { reviewCount: ownReviewIds.size },
    }).catch(() => null)

    return { success: true, reviewId }
  } catch (err) {
    console.error('deleteReview failed:', err)
    return { success: false, error: err.message || '删除失败' }
  }
}
