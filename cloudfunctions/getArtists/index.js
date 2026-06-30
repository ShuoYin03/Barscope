const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

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
        fansSize: true,
      })
      .limit(limit)
      .get()

    const baseList = res.data
      .filter(a => a.artistId && a.artistName)
      .map(a => ({
        id: a._id,
        artistId: String(a.artistId),
        artistName: a.artistName || '',
        picUrl: a.picUrl || a.avatarUrl || '',
        backgroundUrl: a.backgroundUrl || a.coverUrl || a.picUrl || '',
        albumSize: 0,
        fansSize: a.fansSize || 0,
        letter: firstLetter(a.artistName || ''),
      }))

    const listWithCounts = await attachInAppAlbumCounts(baseList)

    const list = listWithCounts.sort((a, b) => {
      if (a.letter !== b.letter) return a.letter.localeCompare(b.letter)
      return a.artistName.localeCompare(b.artistName, 'en', { sensitivity: 'base' })
    })

    return { success: true, list, total: list.length }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

async function attachInAppAlbumCounts(artists) {
  if (!artists.length) return []

  const artistIds = artists.map(a => String(a.artistId)).filter(Boolean)
  const names = artists.map(a => a.artistName).filter(Boolean)
  const countMap = new Map()
  const seenAlbumByArtist = new Map()

  function addCount(artistKey, albumId) {
    if (!artistKey || !albumId) return
    if (!seenAlbumByArtist.has(artistKey)) seenAlbumByArtist.set(artistKey, new Set())
    const seen = seenAlbumByArtist.get(artistKey)
    if (seen.has(albumId)) return
    seen.add(albumId)
    countMap.set(artistKey, (countMap.get(artistKey) || 0) + 1)
  }

  // 1) Most reliable: albums.neteaseArtistId matches artist_candidates.artistId.
  for (let i = 0; i < artistIds.length; i += 100) {
    const chunk = artistIds.slice(i, i + 100)
    const r = await db.collection('albums')
      .where({ neteaseArtistId: _.in(chunk), approved: _.neq(false) })
      .field({ _id: true, neteaseArtistId: true })
      .limit(1000)
      .get()
    ;(r.data || []).forEach(album => addCount(String(album.neteaseArtistId), album._id))
  }

  // 2) Legacy fallback: albums.primaryArtist matches artist name.
  for (let i = 0; i < names.length; i += 100) {
    const chunk = names.slice(i, i + 100)
    const r = await db.collection('albums')
      .where({ primaryArtist: _.in(chunk), approved: _.neq(false) })
      .field({ _id: true, primaryArtist: true })
      .limit(1000)
      .get()
    ;(r.data || []).forEach(album => addCount(`name:${album.primaryArtist}`, album._id))
  }

  return artists.map(artist => ({
    ...artist,
    albumSize: (countMap.get(String(artist.artistId)) || 0) + (countMap.get(`name:${artist.artistName}`) || 0),
  }))
}

function firstLetter(name) {
  const trimmed = String(name || '').trim()
  const match = trimmed.match(/[A-Za-z]/)
  if (!match) return '#'
  return match[0].toUpperCase()
}
