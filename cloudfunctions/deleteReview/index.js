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
      // Recompute from every remaining review, not just the first page, so avgScore stays exact
      // for albums with more than one page of reviews. A deleted review must never keep influencing
      // the average — that's the whole point of doing this here rather than lazily elsewhere.
      let rows = []
      let skip = 0
      while (true) {
        const page = await db.collection('reviews').where({ albumId }).field({ rating: true }).skip(skip).limit(100).get()
        rows = rows.concat(page.data || [])
        if (!page.data || page.data.length < 100) break
        skip += 100
      }
      const sum = rows.reduce((total, item) => total + (Number(item.rating) || 0), 0)
      const count = rows.length
      await db.collection('albums').doc(albumId).update({
        data: {
          avgScore: count ? Math.round((sum / count) * 10) / 10 : 0,
          reviewCount: count,
        },
      })
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
