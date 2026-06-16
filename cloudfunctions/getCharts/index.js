const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { period = 'weekly', limit = 20 } = event

  try {
    // 有评分数据时按 avgScore 排，否则按新碟排
    const { data: scored } = await db.collection('albums')
      .where({ approved: true, avgScore: db.command.gt(0) })
      .orderBy('avgScore', 'desc')
      .limit(1)
      .get()

    const sortField = scored.length > 0 ? 'avgScore' : 'releaseYear'

    const { data } = await db.collection('albums')
      .where({ approved: true })
      .orderBy(sortField, 'desc')
      .limit(limit)
      .get()

    const list = data.map((album, index) => ({
      rank: index + 1,
      albumId: album._id,
      title: album.title,
      artist: album.artist,
      year: album.releaseYear,
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
