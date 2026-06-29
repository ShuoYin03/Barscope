const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const keyword = String(event.keyword || '').trim()
  const limit = Math.min(Number(event.limit || 500), 500)

  try {
    const conditions = { status: 'approved' }
    if (keyword) {
      conditions.artistName = db.RegExp({ regexp: keyword, options: 'i' })
    }

    const res = await db.collection('artist_candidates')
      .where(conditions)
      .field({
        _id: true,
        artistId: true,
        artistName: true,
        picUrl: true,
        avatarUrl: true,
        backgroundUrl: true,
        coverUrl: true,
        albumSize: true,
        fansSize: true,
      })
      .limit(limit)
      .get()

    const list = res.data
      .filter(a => a.artistId && a.artistName)
      .map(a => ({
        id: a._id,
        artistId: String(a.artistId),
        artistName: a.artistName || '',
        picUrl: a.picUrl || a.avatarUrl || '',
        backgroundUrl: a.backgroundUrl || a.coverUrl || a.picUrl || '',
        albumSize: a.albumSize || 0,
        fansSize: a.fansSize || 0,
        letter: firstLetter(a.artistName || ''),
      }))
      .sort((a, b) => {
        if (a.letter !== b.letter) return a.letter.localeCompare(b.letter)
        return a.artistName.localeCompare(b.artistName, 'en', { sensitivity: 'base' })
      })

    return { success: true, list, total: list.length }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

function firstLetter(name) {
  const trimmed = String(name || '').trim()
  const match = trimmed.match(/[A-Za-z]/)
  if (!match) return '#'
  return match[0].toUpperCase()
}
