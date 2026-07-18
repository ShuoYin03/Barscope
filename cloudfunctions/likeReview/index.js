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
    const existing = await db.collection('review_likes').doc(likeId).get().catch(() => ({ data: null }))

    // Toggle off: remove the user's like row and decrement the cached counter safely.
    if (existing && existing.data) {
      await db.collection('review_likes').doc(likeId).remove()
      const reviewRes = await db.collection('reviews').doc(reviewId).get().catch(() => null)
      const currentLikes = Number(reviewRes && reviewRes.data && reviewRes.data.likes || 0)
      if (currentLikes > 0) await db.collection('reviews').doc(reviewId).update({ data: { likes: _.inc(-1) } })
      return { success: true, liked: false, alreadyLiked: true }
    }

    await db.collection('review_likes').doc(likeId).set({
      data: { reviewId, openId: OPENID, createdAt: db.serverDate() },
    })
    await db.collection('reviews').doc(reviewId).update({ data: { likes: _.inc(1) } })

    const [reviewRes, likerRes] = await Promise.all([
      db.collection('reviews').doc(reviewId).get().catch(() => null),
      db.collection('users').where({ openId: OPENID }).limit(1).get().catch(() => null),
    ])
    const review = reviewRes && reviewRes.data
    const likerName = (likerRes && likerRes.data && likerRes.data[0] && likerRes.data[0].nickName) || '匿名用户'
    if (review && review.authorOpenId && review.authorOpenId !== OPENID) {
      await notify(review.authorOpenId, {
        type: 'like',
        message: `${likerName} 赞了你在《${review.albumTitle || '专辑'}》下的评论`,
        albumId: review.albumId || '',
        reviewId,
      })
    }

    return { success: true, liked: true, alreadyLiked: false }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// Best-effort — a notification failure should never block the like itself.
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
