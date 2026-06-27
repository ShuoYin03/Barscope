const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const artistId = event.artistId   // neteaseArtistId string
  if (!artistId) return { success: false, error: 'missing artistId' }

  try {
    const res = await db.collection('artists')
      .where({ neteaseArtistId: String(artistId) })
      .limit(1)
      .get()
    return { success: true, artist: res.data[0] || null }
  } catch (e) {
    return { success: false, error: e.message }
  }
}
