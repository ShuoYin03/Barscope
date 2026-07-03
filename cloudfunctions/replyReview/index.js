const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const reviewId = event.reviewId
  const content = String(event.content || '').trim()
  if (!OPENID) return { success: false, error: 'login required' }
  if (!reviewId || !content) return { success: false, error: 'reviewId and content required' }
  if (content.length > 300) return { success: false, error: 'reply too long' }
  try {
    await db.collection('review_replies').add({ data: { reviewId, content, openId: OPENID, createdAt: db.serverDate() } })
    await db.collection('reviews').doc(reviewId).update({ data: { replyCount: _.inc(1) } })
    return { success: true }
  } catch (err) { return { success: false, error: err.message } }
}
