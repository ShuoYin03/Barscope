const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const artistId = event.artistId   // neteaseArtistId string
  if (!artistId) return { success: false, error: 'missing artistId' }

  try {
    // Newer artist profiles may live in artists; approved crawl candidates keep picUrl.
    const [artistRes, candidateRes] = await Promise.all([
      db.collection('artists')
        .where({ neteaseArtistId: String(artistId) })
        .limit(1)
        .get()
        .catch(() => ({ data: [] })),
      db.collection('artist_candidates')
        .where({ artistId: Number(artistId), status: 'approved' })
        .limit(1)
        .get()
        .catch(() => ({ data: [] })),
    ])

    const artist = artistRes.data[0] || null
    const candidate = candidateRes.data[0] || null

    if (!artist && !candidate) return { success: true, artist: null }

    const avatarUrl = artist?.avatarUrl || artist?.picUrl || candidate?.avatarUrl || candidate?.picUrl || ''
    const heroImageUrl = artist?.heroImageUrl || artist?.backgroundUrl || artist?.coverUrl || candidate?.heroImageUrl || candidate?.backgroundUrl || candidate?.coverUrl || avatarUrl || ''

    return {
      success: true,
      artist: {
        ...(candidate || {}),
        ...(artist || {}),
        artistId: artist?.artistId || candidate?.artistId || Number(artistId),
        artistName: artist?.artistName || artist?.name || candidate?.artistName || '',
        picUrl: avatarUrl,
        avatarUrl,
        backgroundUrl: heroImageUrl,
        coverUrl: heroImageUrl,
        heroImageUrl,
      },
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}
