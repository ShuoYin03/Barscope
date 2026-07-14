const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async () => {
  try {
    const [albums, artists, reviews] = await Promise.all([
      db.collection('albums').count(),
      db.collection('artist_candidates').where({ status: 'approved' }).count(),
      db.collection('reviews').count(),
    ])

    return {
      success: true,
      totalAlbums: Number(albums.total || 0),
      totalArtists: Number(artists.total || 0),
      totalReviews: Number(reviews.total || 0),
    }
  } catch (error) {
    return { success: false, error: error.message }
  }
}
