const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function beijingToday() {
  const now = new Date()
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  return {
    year: beijing.getUTCFullYear(),
    month: String(beijing.getUTCMonth() + 1).padStart(2, '0'),
    day: String(beijing.getUTCDate()).padStart(2, '0'),
  }
}

// Full-catalog scan (paginated, like getArtists' fetchAlbumCounts) — releaseDate isn't a month/day
// index, so there's no cheaper indexed query for "same month+day, any past year".
exports.main = async event => {
  try {
    const { year, month, day } = beijingToday()
    const limit = Math.min(Math.max(Number(event.limit || 8), 1), 20)
    const countRes = await db.collection('albums').where({ approved: _.neq(false) }).count()
    const total = Number(countRes.total || 0)
    if (!total) return { success: true, list: [], month, day }

    const pageSize = 1000
    const pages = Math.ceil(total / pageSize)
    const batches = []
    for (let i = 0; i < pages; i++) {
      batches.push(db.collection('albums').where({ approved: _.neq(false) })
        .field({ _id: true, title: true, artist: true, primaryArtist: true, coverUrl: true, releaseDate: true, releaseYear: true, avgScore: true, reviewCount: true })
        .skip(i * pageSize).limit(pageSize).get())
    }
    const rows = (await Promise.all(batches)).flatMap(r => r.data || [])

    const suffix = `-${month}-${day}`
    const matched = rows.filter(a => {
      const d = String(a.releaseDate || '')
      return d.length === 10 && d.slice(4) === suffix && Number(a.releaseYear || 0) < year
    })
    matched.sort((a, b) => (Number(b.releaseYear || 0) - Number(a.releaseYear || 0)) || ((Number(b.avgScore) || 0) - (Number(a.avgScore) || 0)))

    const list = matched.slice(0, limit).map(a => ({
      albumId: String(a._id),
      title: a.title || '',
      artist: a.artist || a.primaryArtist || '',
      coverUrl: a.coverUrl || '',
      releaseYear: a.releaseYear || 0,
      yearsAgo: year - Number(a.releaseYear || 0),
      avgScore: Number(a.avgScore || 0),
    }))
    return { success: true, list, month, day }
  } catch (err) {
    console.error('getOnThisDay failed:', err)
    return { success: false, error: err.message, list: [] }
  }
}
