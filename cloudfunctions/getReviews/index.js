const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

async function safeGet(task) {
  try { return await task() } catch (err) { console.warn('optional review metadata failed:', err.message); return { data: [] } }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { albumId, userId, page = 1, pageSize = 20 } = event
  if (event.dailyHotAlbum) return getBeijingDailyHotAlbum()
  if (!albumId && !userId && !event.recent) return { success: false, error: 'albumId or userId or recent required' }

  try {
    let records = []
    if (userId) {
      const [newRes, legacyRes] = await Promise.all([
        db.collection('reviews').where({ authorOpenId: userId }).orderBy('createdAt', 'desc').limit(100).get(),
        db.collection('reviews').where({ userId }).orderBy('createdAt', 'desc').limit(100).get(),
      ])
      const seen = new Set()
      records = (newRes.data || []).concat(legacyRes.data || []).filter(r => {
        if (seen.has(r._id)) return false
        seen.add(r._id)
        return true
      }).sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
      records = records.slice((page - 1) * pageSize, page * pageSize)
    } else {
      const skip = (page - 1) * pageSize
      let query
      if (albumId) {
        query = db.collection('reviews').where({ albumId }).orderBy('createdAt', 'desc')
      } else {
        query = db.collection('reviews').orderBy('createdAt', 'desc')
      }
      const result = await query.skip(skip).limit(pageSize).get()
      records = result.data || []
      if (albumId) {
        records.sort((a, b) => {
          const pin = Number(!!b.isPinned) - Number(!!a.isPinned)
          if (pin) return pin
          return (Number(b.likes) || 0) - (Number(a.likes) || 0)
        })
      }
    }

    const reviewIds = records.map(r => r._id)
    const likesRes = OPENID && reviewIds.length
      ? await safeGet(() => db.collection('review_likes').where({ reviewId: _.in(reviewIds), openId: OPENID }).get())
      : { data: [] }
    const repliesRes = reviewIds.length
      ? await safeGet(() => db.collection('review_replies').where({ reviewId: _.in(reviewIds) }).get())
      : { data: [] }

    const liked = new Set((likesRes.data || []).map(x => x.reviewId))
    const replyCounts = {}
    ;(repliesRes.data || []).forEach(x => { replyCounts[x.reviewId] = (replyCounts[x.reviewId] || 0) + 1 })

    const list = records.map(r => ({
      ...r,
      initial: r.userNickName ? r.userNickName[0] : '?',
      userName: r.userNickName || '匿名用户',
      score: String(r.rating || 0),
      timeAgo: formatTimeAgo(r.createdAt),
      likedByMe: liked.has(r._id),
      replyCount: replyCounts[r._id] || r.replyCount || 0,
    }))
    return { success: true, list }
  } catch (err) {
    console.error('getReviews failed:', err)
    return { success: false, error: err.message }
  }
}

async function getBeijingDailyHotAlbum() {
  try {
    const { start, end, dateKey } = beijingDayRange()
    const where = { createdAt: _.gte(start).and(_.lt(end)) }
    const countRes = await db.collection('reviews').where(where).count()
    const total = Number(countRes.total || 0)
    if (!total) return { success: true, album: null, dateKey, reviewCount: 0 }

    const rows = []
    for (let offset = 0; offset < total; offset += 100) {
      const r = await db.collection('reviews').where(where).field({ albumId: true, createdAt: true }).skip(offset).limit(100).get()
      rows.push(...(r.data || []))
    }

    const stats = new Map()
    rows.forEach(review => {
      const id = String(review.albumId || '')
      if (!id) return
      const time = new Date(review.createdAt || 0).getTime()
      const current = stats.get(id) || { albumId: id, reviewCount: 0, latestReviewAt: 0 }
      current.reviewCount += 1
      current.latestReviewAt = Math.max(current.latestReviewAt, time)
      stats.set(id, current)
    })

    const ranked = Array.from(stats.values()).sort((a, b) => (b.reviewCount - a.reviewCount) || (b.latestReviewAt - a.latestReviewAt))
    if (!ranked.length) return { success: true, album: null, dateKey, reviewCount: 0 }

    const ids = ranked.slice(0, 20).map(x => x.albumId)
    const albumRes = await db.collection('albums').where({ _id: _.in(ids), approved: true }).get()
    const albumMap = new Map((albumRes.data || []).map(a => [String(a._id), a]))
    const winner = ranked.find(x => albumMap.has(x.albumId))
    if (!winner) return { success: true, album: null, dateKey, reviewCount: 0 }

    const album = albumMap.get(winner.albumId)
    return {
      success: true,
      dateKey,
      reviewCount: winner.reviewCount,
      album: {
        albumId: String(album._id),
        title: String(album.title || ''),
        artist: String(album.artist || album.primaryArtist || ''),
        year: album.releaseYear || '',
        score: Number(album.avgScore || 0),
        coverUrl: String(album.coverUrl || ''),
        genres: Array.isArray(album.genres) ? album.genres : [],
        todayReviewCount: winner.reviewCount,
      },
    }
  } catch (err) {
    console.error('getBeijingDailyHotAlbum failed:', err)
    return { success: false, error: err.message }
  }
}

function beijingDayRange() {
  const now = new Date()
  const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const y = beijingNow.getUTCFullYear()
  const m = beijingNow.getUTCMonth()
  const d = beijingNow.getUTCDate()
  const start = new Date(Date.UTC(y, m, d) - 8 * 60 * 60 * 1000)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  const dateKey = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return { start, end, dateKey }
}

function formatTimeAgo(date) {
  if (!date) return ''
  const diff = Date.now() - new Date(date).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return days + '天前'
  if (days < 30) return Math.floor(days / 7) + '周前'
  return Math.floor(days / 30) + '个月前'
}
