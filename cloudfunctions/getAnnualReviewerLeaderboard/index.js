const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event = {}) => {
  const year = Number(event.year || 2026)
  const limit = Math.max(1, Math.min(Number(event.limit || 50), 100))
  try {
    const start = new Date(Date.UTC(year - 1, 11, 31, 16, 0, 0))
    const end = new Date(Date.UTC(year, 11, 31, 16, 0, 0))
    const where = { createdAt: _.gte(start).and(_.lt(end)) }
    const countRes = await db.collection('reviews').where(where).count()
    const totalReviews = Number(countRes.total || 0)
    const rows = []
    for (let offset = 0; offset < totalReviews; offset += 100) {
      const res = await db.collection('reviews').where(where)
        .field({ authorOpenId:true, userId:true, userNickName:true, userAvatarUrl:true, albumId:true, rating:true, likes:true, content:true, createdAt:true })
        .skip(offset).limit(100).get()
      rows.push(...(res.data || []))
    }

    const stats = new Map()
    rows.forEach(review => {
      const openId = String(review.authorOpenId || review.userId || '').trim()
      if (!openId) return
      const current = stats.get(openId) || {
        openId,
        nickName: review.userNickName || '匿名用户',
        avatarUrl: review.userAvatarUrl || '',
        reviewCount: 0,
        albums: new Set(),
        ratingTotal: 0,
        ratingCount: 0,
        likesReceived: 0,
        wordCount: 0,
        latestReviewAt: 0,
      }
      current.reviewCount += 1
      if (review.albumId) current.albums.add(String(review.albumId))
      const rating = Number(review.rating)
      if (Number.isFinite(rating) && rating > 0) { current.ratingTotal += rating; current.ratingCount += 1 }
      current.likesReceived += Number(review.likes || 0)
      current.wordCount += Array.from(String(review.content || '').trim()).length
      current.latestReviewAt = Math.max(current.latestReviewAt, new Date(review.createdAt || 0).getTime())
      if (review.userNickName) current.nickName = review.userNickName
      if (review.userAvatarUrl) current.avatarUrl = review.userAvatarUrl
      stats.set(openId, current)
    })

    const list = Array.from(stats.values())
      .map(x => ({
        openId: x.openId,
        nickName: x.nickName,
        avatarUrl: x.avatarUrl,
        reviewCount: x.reviewCount,
        albumCount: x.albums.size,
        avgRating: x.ratingCount ? Number((x.ratingTotal / x.ratingCount).toFixed(1)) : 0,
        likesReceived: x.likesReceived,
        wordCount: x.wordCount,
        latestReviewAt: x.latestReviewAt,
      }))
      .sort((a, b) => (b.reviewCount - a.reviewCount) || (b.albumCount - a.albumCount) || (b.likesReceived - a.likesReceived) || (b.latestReviewAt - a.latestReviewAt))
      .slice(0, limit)

    // reviews snapshot userAvatarUrl/userNickName at submit time, which goes stale once a user
    // changes their profile — pull the live values from users so the leaderboard stays current.
    try {
      const usersRes = await db.collection('users').where({ openId: _.in(list.map(x => x.openId)) }).field({ openId: true, nickName: true, avatarUrl: true }).get()
      const userMap = new Map((usersRes.data || []).map(u => [String(u.openId), u]))
      list.forEach(x => {
        const u = userMap.get(x.openId)
        if (u) { if (u.nickName) x.nickName = u.nickName; if (u.avatarUrl) x.avatarUrl = u.avatarUrl }
      })
    } catch (e) { console.warn('getAnnualReviewerLeaderboard live profile lookup failed:', e.message) }

    const cloudUrls = Array.from(new Set(list.map(x => x.avatarUrl).filter(x => typeof x === 'string' && x.startsWith('cloud://'))))
    if (cloudUrls.length) {
      try {
        const temp = await cloud.getTempFileURL({ fileList: cloudUrls })
        const map = new Map((temp.fileList || []).filter(x => x.status === 0).map(x => [x.fileID, x.tempFileURL]))
        list.forEach(x => { if (map.has(x.avatarUrl)) x.avatarUrl = map.get(x.avatarUrl) })
      } catch (e) {}
    }

    return { success:true, year, totalReviews, totalReviewers:stats.size, list }
  } catch (e) {
    console.error('getAnnualReviewerLeaderboard failed:', e)
    return { success:false, error:e.message }
  }
}
