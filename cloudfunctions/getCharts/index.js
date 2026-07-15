const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { period = 'weekly', limit = 20 } = event

  try {
    const { data: scored } = await db.collection('albums')
      .where({ approved: true, avgScore: db.command.gt(0) })
      .orderBy('avgScore', 'desc')
      .limit(1)
      .get()

    const sortField = scored.length > 0 ? 'avgScore' : 'releaseYear'
    const where = period === 'release2026'
      ? { approved: true, releaseYear: 2026 }
      : { approved: true }

    const { data } = await db.collection('albums')
      .where(where)
      .orderBy(sortField, 'desc')
      .limit(limit)
      .get()

    const list = data.map((album, index) => ({
      rank: index + 1,
      albumId: album._id,
      title: album.title,
      artist: album.artist,
      year: album.releaseYear,
      releaseYear: album.releaseYear,
      releaseDate: album.releaseDate || '',
      score: album.avgScore || 0,
      scoreFill: Math.round((album.avgScore || 0) / 10 * 100) + '%',
      coverUrl: album.coverUrl || '',
      trend: 'same',
      trendText: '─',
    }))

    return { success: true, list, period }
  } catch (err) {
    return { success: false, error: err.message }
  }
}