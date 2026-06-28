const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const albumDocId = event.albumId || event.id
  const sourceId = event.sourceId

  if (!albumDocId && !sourceId) {
    return { success: false, error: 'missing albumId or sourceId' }
  }

  try {
    let albumDoc = null
    if (albumDocId) {
      const res = await db.collection('albums').doc(albumDocId).get()
      albumDoc = res.data
    } else {
      const res = await db.collection('albums').where({ sourceId: String(sourceId) }).limit(1).get()
      albumDoc = res.data[0]
    }

    if (!albumDoc) return { success: false, error: 'album not found' }

    const neteaseAlbumId = String(sourceId || albumDoc.sourceId || '')
    if (!neteaseAlbumId) return { success: false, error: 'missing sourceId' }

    const detail = await fetchAlbumDetail(neteaseAlbumId)
    if (!detail || detail.code !== 200) return { success: false, error: 'netease album api failed' }

    const album = detail.album || {}
    const songs = detail.songs || album.songs || []
    const primaryArtistNames = getPrimaryArtistNames(albumDoc, album)
    const tracks = songs.map((song, idx) => normalizeTrack(song, idx, primaryArtistNames))
    const featuringGuests = collectGuests(tracks)

    const patch = {
      description: cleanText(album.description || album.desc || album.briefDesc || ''),
      company: album.company || album.subType || '',
      trackCount: tracks.length || album.size || albumDoc.trackCount || 0,
      tracks,
      featuringGuests,
      trackSyncedAt: db.serverDate(),
    }

    await db.collection('albums').doc(albumDoc._id).update({ data: patch })

    return {
      success: true,
      albumId: albumDoc._id,
      sourceId: neteaseAlbumId,
      trackCount: tracks.length,
      guestCount: featuringGuests.length,
      description: patch.description,
      tracks,
      featuringGuests,
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

function getPrimaryArtistNames(albumDoc, album) {
  const names = new Set()
  ;[albumDoc.primaryArtist, albumDoc.artist]
    .filter(Boolean)
    .forEach(v => String(v).split(/[\/,&，、]/).map(s => s.trim()).filter(Boolean).forEach(n => names.add(n)))

  if (album.artist && album.artist.name) names.add(album.artist.name)
  if (Array.isArray(album.artists)) {
    album.artists.forEach(a => a && a.name && names.add(a.name))
  }
  return names
}

function normalizeTrack(song, idx, primaryArtistNames) {
  const artists = (song.artists || song.ar || [])
    .map(a => ({ id: Number(a.id || 0), name: a.name || '' }))
    .filter(a => a.name)

  const guests = artists.filter(a => !primaryArtistNames.has(a.name))

  return {
    songId: String(song.id || ''),
    no: idx + 1,
    name: song.name || '',
    duration: Number(song.duration || song.dt || 0),
    artists,
    guests,
  }
}

function collectGuests(tracks) {
  const map = new Map()
  tracks.forEach(track => {
    ;(track.guests || []).forEach(guest => {
      const key = guest.id ? String(guest.id) : guest.name
      if (!map.has(key)) map.set(key, { id: guest.id || 0, name: guest.name, count: 0 })
      map.get(key).count += 1
    })
  })
  return Array.from(map.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function fetchAlbumDetail(albumId) {
  return httpsGetJson(`https://music.163.com/api/album/${albumId}`)
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com/',
        'Accept': 'application/json,text/plain,*/*',
      },
    }, res => {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) }
        catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function cleanText(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
