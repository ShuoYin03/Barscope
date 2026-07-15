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

    const [reviewRes, replierRes] = await Promise.all([
      db.collection('reviews').doc(reviewId).get().catch(() => null),
      db.collection('users').where({ openId: OPENID }).limit(1).get().catch(() => null),
    ])
    const review = reviewRes && reviewRes.data
    const replierName = (replierRes && replierRes.data && replierRes.data[0] && replierRes.data[0].nickName) || '匿名用户'
    if (review && review.authorOpenId && review.authorOpenId !== OPENID) {
      await notify(review.authorOpenId, {
        type: 'reply',
        message: `${replierName} 回复了你在《${review.albumTitle || '专辑'}》下的评论：${content.slice(0, 40)}`,
        albumId: review.albumId || '',
        reviewId,
      })
    }

    return { success: true }
  } catch (err) { return { success: false, error: err.message } }
}

// Best-effort — a notification failure should never block the reply itself.
async function notify(recipientOpenId, data) {
  try {
    await ensureCollection('notifications')
    await db.collection('notifications').add({ data: { recipientOpenId, read: false, createdAt: db.serverDate(), ...data } })
  } catch (e) { /* ignore */ }
}

async function ensureCollection(name) {
  try { await db.collection(name).limit(1).get() }
  catch (e) {
    const msg = String(e && (e.errMsg || e.message) || '')
    if (!msg.includes('DATABASE_COLLECTION_NOT_EXIST') && !msg.includes('collection not exists') && !msg.includes('Db or Table not exist')) throw e
    try { await db.createCollection(name) } catch (x) {
      if (!String(x && (x.errMsg || x.message) || '').includes('already exists')) throw x
    }
  }
}
