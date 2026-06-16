const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _  = db.command

/**
 * 点赞一条评论（原子 +1，不鉴权）
 * event.reviewId : string
 */
exports.main = async (event, context) => {
  var reviewId = event.reviewId
  if (!reviewId) return { success: false, error: 'reviewId required' }

  try {
    await db.collection('reviews').doc(reviewId).update({
      data: { likes: _.inc(1) },
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
