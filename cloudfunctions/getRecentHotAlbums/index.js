const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event = {}) => {
  const limit = Math.max(1, Math.min(Number(event.limit || 5), 10))
  const days = Math.max(1, Math.min(Number(event.days || 30), 90))

  try {
    const end = new Date()
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
    const where = { createdAt: _.gte(start).and(_.lt(end)) }
    const countRes = await db.collection('reviews').where(where).count()
    const total = Number(countRes.total || 0)
    if (!total) return { success: true, list: [], days }

    const rows = []
    for (let offset = 0; offset < total; offset += 100) {
      const res = await db.collection('reviews')
        .where(where)
        .field({ albumId: true, createdAt: true })
        .skip(offset)
        .limit(100)
        .get()
      rows.push(...(res.data || []))
    }

    const stats = new Map()
    rows.forEach(review => {
      const albumId = String(review.albumId || '')
      if (!albumId) return
      const latestReviewAt = new Date(review.createdAt || 0).getTime()
      const current = stats.get(albumId) || { albumId, reviewCount: 0, latestReviewAt: 0 }
      current.reviewCount += 1
      current.latestReviewAt = Math.max(current.latestReviewAt, latestReviewAt)
      stats.set(albumId, current)
    })

    const ranked = Array.from(stats.values())
      .sort((a, b) => (b.reviewCount - a.reviewCount) || (b.latestReviewAt - a.latestReviewAt))

    const candidateIds = ranked.slice(0, 50).map(item => item.albumId)
    if (!candidateIds.length) return { success: true, list: [], days }

    const albumsRes = await db.collection('albums')
      .where({ _id: _.in(candidateIds), approved: true })
      .get()
    const albumMap = new Map((albumsRes.data || []).map(album => [String(album._id), album]))

    const list = ranked
      .filter(item => albumMap.has(item.albumId))
      .slice(0, limit)
      .map(item => {
        const album = albumMap.get(item.albumId)
        return {
          albumId: String(album._id),
          title: String(album.title || ''),
          artist: String(album.artist || album.primaryArtist || ''),
          score: Number(album.avgScore || 0),
          reviewCount: item.reviewCount,
          latestReviewAt: item.latestReviewAt,
        }
      })

    return { success: true, list, days }
  } catch (err) {
    console.error('getRecentHotAlbums failed:', err)
    return { success: false, error: err.message }
  }
}
