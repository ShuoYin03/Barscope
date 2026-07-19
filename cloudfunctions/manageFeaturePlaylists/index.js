const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const FEATURE_ID = '2026-h1-top-50-tracks'

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://music.163.com/',
      },
    }, res => {
      let buf = ''
      res.on('data', chunk => { buf += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) }
        catch (e) { reject(new Error('invalid_netease_response')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => {
      req.destroy()
      reject(new Error('netease_timeout'))
    })
  })
}

function extractPlaylistId(input) {
  const value = String(input || '').trim()
  if (/^\d+$/.test(value)) return value
  const match = value.match(/[?&#]id=(\d+)/i) || value.match(/playlist\/(\d+)/i)
  return match ? match[1] : ''
}

async function checkAdmin(openId) {
  if (!openId) return false
  try {
    const result = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
    return result.data.length > 0
  } catch (e) {
    return false
  }
}

async function fetchSongDetails(ids) {
  const songs = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const data = await httpsGet(`https://music.163.com/api/song/detail?ids=${encodeURIComponent(JSON.stringify(chunk))}`)
    if (data && Array.isArray(data.songs)) songs.push(...data.songs)
  }
  return songs
}

function normalizeTrack(song, position) {
  const artists = (song.artists || song.ar || []).map(artist => ({
    id: String(artist.id || ''),
    name: String(artist.name || '').trim(),
  })).filter(artist => artist.name)
  const album = song.album || song.al || {}
  return {
    position,
    neteaseSongId: String(song.id || ''),
    songName: String(song.name || '').trim(),
    artists,
    artistNames: artists.map(artist => artist.name),
    albumId: String(album.id || ''),
    albumName: String(album.name || '').trim(),
    coverUrl: album.picUrl || '',
    durationMs: Number(song.duration || song.dt || 0),
  }
}

async function fetchPlaylist(playlistId) {
  const data = await httpsGet(`https://music.163.com/api/v6/playlist/detail?id=${playlistId}&n=1000&s=0`)
  const playlist = data && playlistFromResponse(data)
  if (!playlist) throw new Error('playlist_not_found')

  const trackIds = (playlist.trackIds || []).map(item => String(item.id || '')).filter(Boolean)
  let rawTracks = Array.isArray(playlist.tracks) ? playlist.tracks : []

  if (trackIds.length && rawTracks.length < trackIds.length) {
    const existingIds = new Set(rawTracks.map(track => String(track.id || '')))
    const missingIds = trackIds.filter(id => !existingIds.has(id))
    const missingTracks = await fetchSongDetails(missingIds)
    rawTracks = rawTracks.concat(missingTracks)
  }

  const trackMap = new Map(rawTracks.map(track => [String(track.id || ''), track]))
  const orderedTracks = trackIds.length
    ? trackIds.map(id => trackMap.get(id)).filter(Boolean)
    : rawTracks

  return {
    title: playlist.name || '',
    description: playlist.description || '',
    coverUrl: playlist.coverImgUrl || '',
    creator: playlist.creator ? {
      userId: String(playlist.creator.userId || ''),
      nickname: playlist.creator.nickname || '',
      avatarUrl: playlist.creator.avatarUrl || '',
    } : null,
    trackCount: orderedTracks.length,
    tracks: orderedTracks.map((track, index) => normalizeTrack(track, index + 1)),
  }
}

function playlistFromResponse(data) {
  if (data.playlist) return data.playlist
  if (data.result) return data.result
  return null
}

async function importPlaylist(event, openId) {
  const creatorName = String(event.creatorName || '').trim()
  const playlistId = extractPlaylistId(event.playlistUrl || event.playlistId)
  if (!creatorName) return { success: false, error: 'creator_name_required' }
  if (!playlistId) return { success: false, error: 'invalid_playlist_url' }

  const playlist = await fetchPlaylist(playlistId)
  const now = new Date()
  const payload = {
    featureId: FEATURE_ID,
    creatorName,
    neteasePlaylistId: playlistId,
    neteasePlaylistUrl: `https://music.163.com/#/playlist?id=${playlistId}`,
    playlistTitle: playlist.title,
    playlistDescription: playlist.description,
    playlistCoverUrl: playlist.coverUrl,
    neteaseCreator: playlist.creator,
    trackCount: playlist.trackCount,
    tracks: playlist.tracks,
    importedBy: openId,
    updatedAt: now,
  }

  const existing = await db.collection('feature_playlist_submissions')
    .where({ featureId: FEATURE_ID, neteasePlaylistId: playlistId })
    .limit(1)
    .get()

  if (existing.data.length) {
    const id = existing.data[0]._id
    await db.collection('feature_playlist_submissions').doc(id).update({ data: payload })
    return { success: true, updated: true, submissionId: id, playlist: payload }
  }

  const result = await db.collection('feature_playlist_submissions').add({
    data: { ...payload, createdAt: now },
  })
  return { success: true, updated: false, submissionId: result._id, playlist: payload }
}

async function listSubmissions() {
  const result = await db.collection('feature_playlist_submissions')
    .where({ featureId: FEATURE_ID })
    .orderBy('updatedAt', 'desc')
    .limit(100)
    .get()
  return { success: true, list: result.data }
}

async function removeSubmission(id) {
  if (!id) return { success: false, error: 'id_required' }
  await db.collection('feature_playlist_submissions').doc(id).remove()
  return { success: true }
}

exports.main = async (event) => {
  const action = event.action || 'list'
  const { OPENID: openId } = cloud.getWXContext()
  if (!openId || !(await checkAdmin(openId))) return { success: false, error: 'unauthorized' }

  try {
    if (action === 'import') return await importPlaylist(event, openId)
    if (action === 'list') return await listSubmissions()
    if (action === 'remove') return await removeSubmission(event.id)
    return { success: false, error: 'unknown_action' }
  } catch (error) {
    console.error('[manageFeaturePlaylists]', action, error)
    return { success: false, error: error.message || 'unknown_error' }
  }
}
