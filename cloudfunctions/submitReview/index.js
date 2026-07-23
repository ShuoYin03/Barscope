const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const { moderateText } = require('./_shared/contentModeration')

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { albumId, albumTitle, rating, content } = event
  if (!albumId || !rating || !content) return { success: false, error: '参数不完整' }
  if (rating < 1 || rating > 10) return { success: false, error: '评分范围 1-10' }

  const moderation = moderateText(content, { minLength: 10, maxLength: 5000, fieldLabel: '评论内容' })
  if (!moderation.ok) return { success: false, error: moderation.error, moderationCode: moderation.code }

  try {
    const { data: users } = await db.collection('users').where({ openId: OPENID }).limit(1).get()
    if (!users.length) return { success: false, error: '请先登录' }
    const user = users[0]

    // The existing database has a legacy UNIQUE index on { albumId, userId }.
    // Keep authorOpenId as the true account identifier, while assigning each review
    // its own unique userId so users can publish multiple reviews on one album.
    const reviewUserId = `${OPENID}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await db.collection('reviews').add({
      data: {
        albumId,
        albumTitle: albumTitle || '',
        userId: reviewUserId,
        authorOpenId: OPENID,
        userType: user.type || 'normal',
        userNickName: user.nickName || '匿名用户',
        userAvatarUrl: user.avatarUrl || '',
        rating,
        content: moderation.content,
        likes: 0,
        replyCount: 0,
        isPinned: user.type === 'critic',
        createdAt: db.serverDate(),
      },
    })

    // Paginate through every review, not just the default page, so avgScore stays exact once an
    // album passes 100 reviews.
    let allReviews = []
    let skip = 0
    while (true) {
      const page = await db.collection('reviews').where({ albumId }).field({ rating: true }).skip(skip).limit(100).get()
      allReviews = allReviews.concat(page.data || [])
      if (!page.data || page.data.length < 100) break
      skip += 100
    }
    const sum = allReviews.reduce((acc, r) => acc + (Number(r.rating) || 0), 0)
    const count = allReviews.length
    await db.collection('albums').doc(albumId).update({ data: { avgScore: count ? Math.round(sum / count * 10) / 10 : 0, reviewCount: count } })
    await db.collection('users').where({ openId: OPENID }).update({ data: { reviewCount: _.inc(1) } })
    return { success: true }
  } catch (err) { return { success: false, error: err.message } }
}
