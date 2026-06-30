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
  const albumsByArtistId = new Map()
  const artistIdByName = new Map()

  artists.forEach(artist => {
    albumsByArtistId.set(String(artist.artistId), new Set())
    artistIdByName.set(artist.artistName, String(artist.artistId))
  })

  function addAlbumToArtist(artistId, albumId) {
    const key = String(artistId || '')
    if (!key || !albumId) return
    if (!albumsByArtistId.has(key)) albumsByArtistId.set(key, new Set())
    albumsByArtistId.get(key).add(albumId)
  }

  // 1) Most reliable: albums.neteaseArtistId matches artist_candidates.artistId.
  for (let i = 0; i < artistIds.length; i += 100) {
    const chunk = artistIds.slice(i, i + 100)
    const r = await db.collection('albums')
      .where({ neteaseArtistId: _.in(chunk), approved: _.neq(false) })
      .field({ _id: true, neteaseArtistId: true })
      .limit(1000)
      .get()
    ;(r.data || []).forEach(album => addAlbumToArtist(album.neteaseArtistId, album._id))
  }

  // 2) Legacy fallback: albums.primaryArtist matches artist name.
  // Important: add into the same artistId Set, so albums matched by both strategies are not double-counted.
  for (let i = 0; i < names.length; i += 100) {
    const chunk = names.slice(i, i + 100)
    const r = await db.collection('albums')
      .where({ primaryArtist: _.in(chunk), approved: _.neq(false) })
      .field({ _id: true, primaryArtist: true })
      .limit(1000)
      .get()
    ;(r.data || []).forEach(album => {
      const artistId = artistIdByName.get(album.primaryArtist)
      addAlbumToArtist(artistId, album._id)
    })
  }

  return artists.map(artist => ({
    ...artist,
    albumSize: (albumsByArtistId.get(String(artist.artistId)) || new Set()).size,
  }))
}

function firstLetter(name) {
  const trimmed = String(name || '').trim()
  const match = trimmed.match(/[A-Za-z]/)
  if (!match) return '#'
  return match[0].toUpperCase()
}
