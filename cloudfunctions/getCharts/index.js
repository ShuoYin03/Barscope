const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function isReleasedIn2026(album) {
  const releaseYear = String(album.releaseYear || '').trim()
  const releaseDate = String(album.releaseDate || '').trim()
  return releaseYear === '2026' || /^2026[-/.]/.test(releaseDate)
}

function sortAlbums(a, b) {
  const scoreDiff = Number(b.avgScore || 0) - Number(a.avgScore || 0)
  if (scoreDiff !== 0) return scoreDiff
  return String(b.releaseDate || '').localeCompare(String(a.releaseDate || ''))
}

async function loadRelease2026Albums(limit) {
  const [numericYear, stringYear, dateYear] = await Promise.all([
    db.collection('albums').where({ approved: true, releaseYear: 2026 }).limit(100).get(),
    db.collection('albums').where({ approved: true, releaseYear: '2026' }).limit(100).get(),
    db.collection('albums').where({
      approved: true,
      releaseDate: db.RegExp({ regexp: '^2026[-/.]', options: '' }),
    }).limit(100).get(),
  ])

  const merged = new Map()
  ;[...numericYear.data, ...stringYear.data, ...dateYear.data].forEach(album => {
    if (album && album._id && isReleasedIn2026(album)) merged.set(album._id, album)
  })

  return Array.from(merged.values()).sort(sortAlbums).slice(0, limit)
}

exports.main = async (event) => {
  const { period = 'weekly', limit = 20 } = event

  try {
    let data = []

    if (period === 'release2026') {
      data = await loadRelease2026Albums(limit)
    } else {
      const { data: scored } = await db.collection('albums')
        .where({ approved: true, avgScore: _.gt(0) })
        .orderBy('avgScore', 'desc')
        .limit(1)
        .get()

      const sortField = scored.length > 0 ? 'avgScore' : 'releaseYear'
      const result = await db.collection('albums')
        .where({ approved: true })
        .orderBy(sortField, 'desc')
        .limit(limit)
        .get()
      data = result.data
    }

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
