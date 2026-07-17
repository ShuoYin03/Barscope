const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

async function safeGet(task) {
  try { return await task() } catch (err) { console.warn('optional review metadata failed:', err.message); return { data: [] } }
}

// cloud:// fileIDs (from wx.cloud.uploadFile) don't render directly in <image src> under every
// render context, so any avatar/cover pulled from storage needs resolving to a temp HTTPS URL
// before it's sent to the client. Temp URLs expire, so this happens fresh on every read.
async function resolveCloudUrls(urls) {
  const targets = Array.from(new Set(urls.filter(u => typeof u === 'string' && u.startsWith('cloud://'))))
  if (!targets.length) return new Map()
  try {
    const res = await cloud.getTempFileURL({ fileList: targets })
    const map = new Map()
    ;(res.fileList || []).forEach(f => { if (f.status === 0 && f.tempFileURL) map.set(f.fileID, f.tempFileURL) })
    return map
  } catch (e) {
    console.warn('resolveCloudUrls failed:', e.message)
    return new Map()
  }
}
function applyResolvedUrl(url, map) {
  return (url && map.get(url)) || url
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { albumId, userId, page = 1, pageSize = 20, likedBy, followingFeed } = event
  if (event.dailyHotAlbums || event.dailyHotAlbum) return getBeijingDailyHotAlbums(Number(event.limit || 6))
  if (event.monthlyTopCritics) return getMonthlyTopCritics(Number(event.limit || 8))
  if (event.totalCount) return getTotalReviewCount()
  if (likedBy) return getLikedReviews(likedBy, page, pageSize, OPENID)
  if (followingFeed) {
    if (!OPENID) return { success: false, error: '请先登录' }
    return getFollowingFeed(OPENID, page, pageSize)
  }
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
      if (albumId) query = db.collection('reviews').where({ albumId }).orderBy('createdAt', 'desc')
      else query = db.collection('reviews').orderBy('createdAt', 'desc')
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

    const list = await enrichReviews(records, OPENID)
    return { success: true, list }
  } catch (err) {
    console.error('getReviews failed:', err)
    return { success: false, error: err.message }
  }
}

async function enrichReviews(records, OPENID) {
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

  // reviews snapshot userAvatarUrl/userNickName at submit time, which goes stale once a user
  // changes their profile — pull the live values from users so every review card stays current.
  const authorOpenIds = Array.from(new Set(records.map(r => r.authorOpenId).filter(Boolean)))
  const liveUserMap = new Map()
  if (authorOpenIds.length) {
    try {
      const usersRes = await db.collection('users').where({ openId: _.in(authorOpenIds) }).field({ openId: true, nickName: true, avatarUrl: true }).get()
      ;(usersRes.data || []).forEach(u => liveUserMap.set(String(u.openId), u))
    } catch (e) { console.warn('enrichReviews live profile lookup failed:', e.message) }
  }

  const avatarMap = await resolveCloudUrls(records.map(r => {
    const live = liveUserMap.get(r.authorOpenId)
    return (live && live.avatarUrl) || r.userAvatarUrl
  }))

  return records.map(r => {
    const live = liveUserMap.get(r.authorOpenId)
    const nickName = (live && live.nickName) || r.userNickName
    const avatarUrl = (live && live.avatarUrl) || r.userAvatarUrl
    return {
      ...r,
      userAvatarUrl: applyResolvedUrl(avatarUrl, avatarMap),
      initial: nickName ? nickName[0] : '?',
      userName: nickName || '匿名用户',
      score: String(r.rating || 0),
      timeAgo: formatTimeAgo(r.createdAt),
      likedByMe: liked.has(r._id),
      replyCount: replyCounts[r._id] || r.replyCount || 0,
    }
  })
}

async function getLikedReviews(likedBy, page, pageSize, OPENID) {
  try {
    const likesRes = await db.collection('review_likes').where({ openId: likedBy }).orderBy('createdAt', 'desc').skip((page - 1) * pageSize).limit(pageSize).get()
    const likeRows = likesRes.data || []
    if (!likeRows.length) return { success: true, list: [] }
    const reviewIds = likeRows.map(x => x.reviewId)
    const reviewsRes = await db.collection('reviews').where({ _id: _.in(reviewIds) }).get()
    const reviewMap = new Map((reviewsRes.data || []).map(r => [String(r._id), r]))
    const records = likeRows.map(x => reviewMap.get(String(x.reviewId))).filter(Boolean)
    const list = await enrichReviews(records, OPENID)
    return { success: true, list }
  } catch (err) {
    console.error('getLikedReviews failed:', err)
    return { success: false, error: err.message }
  }
}

async function getFollowingFeed(OPENID, page, pageSize) {
  try {
    let followingIds = []
    try {
      const followRes = await db.collection('follows').where({ followerOpenId: OPENID }).get()
      followingIds = (followRes.data || []).map(x => x.followingOpenId)
    } catch (e) {
      if (!isCollectionMissing(e)) throw e
    }
    if (!followingIds.length) return { success: true, list: [] }
    const skip = (page - 1) * pageSize
    const result = await db.collection('reviews').where({ authorOpenId: _.in(followingIds) }).orderBy('createdAt', 'desc').skip(skip).limit(pageSize).get()
    const list = await enrichReviews(result.data || [], OPENID)
    return { success: true, list }
  } catch (err) {
    console.error('getFollowingFeed failed:', err)
    return { success: false, error: err.message }
  }
}

function isCollectionMissing(e) {
  const msg = String(e && (e.errMsg || e.message) || '')
  return msg.includes('DATABASE_COLLECTION_NOT_EXIST') || msg.includes('collection not exists') || msg.includes('Db or Table not exist')
}

async function getTotalReviewCount() {
  try {
    const countRes = await db.collection('reviews').count()
    return { success: true, total: Number(countRes.total || 0) }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

async function getBeijingDailyHotAlbums(limit = 6) {
  try {
    const { start, end, dateKey } = beijingDayRange()
    const where = { createdAt: _.gte(start).and(_.lt(end)) }
    const countRes = await db.collection('reviews').where(where).count()
    const total = Number(countRes.total || 0)
    if (!total) return { success: true, albums: [], album: null, dateKey, reviewCount: 0 }

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
    if (!ranked.length) return { success: true, albums: [], album: null, dateKey, reviewCount: 0 }

    const ids = ranked.slice(0, 30).map(x => x.albumId)
    const albumRes = await db.collection('albums').where({ _id: _.in(ids), approved: true }).get()
    const albumMap = new Map((albumRes.data || []).map(a => [String(a._id), a]))
    const albums = ranked
      .filter(x => albumMap.has(x.albumId))
      .slice(0, Math.max(1, Math.min(limit, 10)))
      .map(item => {
        const album = albumMap.get(item.albumId)
        return {
          albumId: String(album._id),
          title: String(album.title || ''),
          artist: String(album.artist || album.primaryArtist || ''),
          year: album.releaseYear || '',
          score: Number(album.avgScore || 0),
          coverUrl: String(album.coverUrl || ''),
          genres: Array.isArray(album.genres) ? album.genres : [],
          todayReviewCount: item.reviewCount,
          latestReviewAt: item.latestReviewAt,
        }
      })

    return {
      success: true,
      dateKey,
      reviewCount: albums.reduce((sum, item) => sum + Number(item.todayReviewCount || 0), 0),
      albums,
      album: albums[0] || null,
    }
  } catch (err) {
    console.error('getBeijingDailyHotAlbums failed:', err)
    return { success: false, error: err.message }
  }
}

async function getMonthlyTopCritics(limit = 8) {
  try {
    const { start, end, monthKey } = beijingMonthRange()
    const where = { createdAt: _.gte(start).and(_.lt(end)) }
    const countRes = await db.collection('reviews').where(where).count()
    const total = Number(countRes.total || 0)
    if (!total) return { success: true, monthKey, list: [] }

    const rows = []
    for (let offset = 0; offset < total; offset += 100) {
      const r = await db.collection('reviews').where(where).field({ authorOpenId: true, userNickName: true, userAvatarUrl: true, userType: true }).skip(offset).limit(100).get()
      rows.push(...(r.data || []))
    }

    const stats = new Map()
    rows.forEach(review => {
      const openId = String(review.authorOpenId || '')
      if (!openId) return
      const current = stats.get(openId) || { openId, count: 0, nickName: review.userNickName || '匿名用户', avatarUrl: review.userAvatarUrl || '', userType: review.userType || 'normal' }
      current.count += 1
      stats.set(openId, current)
    })

    const ranked = Array.from(stats.values()).sort((a, b) => b.count - a.count).slice(0, Math.max(1, Math.min(limit, 20)))

    // reviews snapshot userAvatarUrl/userNickName at submit time, which goes stale once a user
    // changes their profile — pull the live values from users so the leaderboard stays current.
    try {
      const usersRes = await db.collection('users').where({ openId: _.in(ranked.map(r => r.openId)) }).field({ openId: true, nickName: true, avatarUrl: true }).get()
      const userMap = new Map((usersRes.data || []).map(u => [String(u.openId), u]))
      ranked.forEach(r => {
        const u = userMap.get(r.openId)
        if (u) { if (u.nickName) r.nickName = u.nickName; if (u.avatarUrl) r.avatarUrl = u.avatarUrl }
      })
    } catch (e) { console.warn('getMonthlyTopCritics live profile lookup failed:', e.message) }

    const avatarMap = await resolveCloudUrls(ranked.map(r => r.avatarUrl))
    ranked.forEach(r => { r.avatarUrl = applyResolvedUrl(r.avatarUrl, avatarMap) })
    return { success: true, monthKey, list: ranked }
  } catch (err) {
    console.error('getMonthlyTopCritics failed:', err)
    return { success: false, error: err.message }
  }
}

function beijingMonthRange() {
  const now = new Date()
  const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const y = beijingNow.getUTCFullYear()
  const m = beijingNow.getUTCMonth()
  const start = new Date(Date.UTC(y, m, 1) - 8 * 60 * 60 * 1000)
  const end = new Date(Date.UTC(y, m + 1, 1) - 8 * 60 * 60 * 1000)
  const monthKey = `${y}-${String(m + 1).padStart(2, '0')}`
  return { start, end, monthKey }
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
