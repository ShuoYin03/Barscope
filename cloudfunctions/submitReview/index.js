const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { albumId, albumTitle, rating, content } = event
  if (!albumId || !rating || !content) return { success: false, error: '参数不完整' }
  if (rating < 1 || rating > 10) return { success: false, error: '评分范围 1-10' }

  try {
    const { data: users } = await db.collection('users').where({ openId: OPENID }).limit(1).get()
    if (!users.length) return { success: false, error: '请先登录' }
    const user = users[0]

    // A user may post more than one review for the same album.
    await db.collection('reviews').add({
      data: {
        albumId,
        albumTitle: albumTitle || '',
        userId: OPENID,
        userType: user.type || 'normal',
        userNickName: user.nickName || '匿名用户',
        userAvatarUrl: user.avatarUrl || '',
        rating,
        content: String(content).trim(),
        likes: 0,
        replyCount: 0,
        isPinned: user.type === 'critic',
        createdAt: db.serverDate(),
      },
    })

    const { data: allReviews } = await db.collection('reviews').where({ albumId }).field({ rating: true }).get()
    const sum = allReviews.reduce((acc, r) => acc + (Number(r.rating) || 0), 0)
    const count = allReviews.length
    const avgScore = count ? Math.round(sum / count * 10) / 10 : 0
    await db.collection('albums').doc(albumId).update({ data: { avgScore, reviewCount: count } })
    await db.collection('users').where({ openId: OPENID }).update({ data: { reviewCount: _.inc(1) } })
    return { success: true }
  } catch (err) { return { success: false, error: err.message } }
}
