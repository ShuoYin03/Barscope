const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

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

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\-_·•:：()（）\[\]【】'"“”‘’]/g, '')
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
    picUrl: artist.picUrl || artist.img1v1Url || '',
  })).filter(artist => artist.name)
  const album = song.album || song.al || {}
  const publishTime = Number(album.publishTime || album.publishTimestamp || 0)
  return {
    position,
    neteaseSongId: String(song.id || ''),
    songName: String(song.name || '').trim(),
    artists,
    artistNames: artists.map(artist => artist.name),
    albumId: String(album.id || ''),
    albumName: String(album.name || '').trim(),
    albumTrackCount: Number(album.size || album.trackCount || 0),
    albumReleaseYear: publishTime ? new Date(publishTime).getFullYear() : 0,
    coverUrl: album.picUrl || '',
    durationMs: Number(song.duration || song.dt || 0),
  }
}

async function fetchAlbumArtists(albumId) {
  try {
    const data = await httpsGet(`https://music.163.com/api/v1/album/${albumId}`)
    const album = (data && data.album) || (data && data.data && data.data.album) || {}
    const raw = (Array.isArray(album.artists) && album.artists.length) ? album.artists : (album.artist ? [album.artist] : [])
    return raw
      .map(a => ({ id: String(a && a.id || ''), name: String(a && a.name || '').trim() }))
      .filter(a => a.name)
  } catch (e) {
    return null
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

function publicMeta(item) {
  const isEditorial = item.sourceType !== 'community'
  return {
    _id: item._id,
    creatorName: item.creatorName || item.neteaseCreator?.nickname || '网易云用户',
    neteasePlaylistId: item.neteasePlaylistId,
    neteasePlaylistUrl: item.neteasePlaylistUrl,
    playlistTitle: item.playlistTitle,
    playlistCoverUrl: item.playlistCoverUrl,
    trackCount: item.trackCount || 0,
    neteaseCreator: item.neteaseCreator || null,
    sourceType: isEditorial ? 'editorial' : 'community',
    isEditorial,
    editorialPriority: Number(item.editorialPriority || (isEditorial ? 100 : 0)),
    updatedAt: item.updatedAt,
  }
}

async function queryByIds(collectionName, field, ids, projection) {
  const unique = Array.from(new Set((ids || []).map(x => String(x || '')).filter(Boolean)))
  const rows = []
  for (let i = 0; i < unique.length; i += 100) {
    try {
      const chunk = unique.slice(i, i + 100)
      let query = db.collection(collectionName).where({ [field]: _.in(chunk) })
      if (projection) query = query.field(projection)
      const result = await query.limit(chunk.length).get()
      rows.push(...(result.data || []))
    } catch (e) {
      // A review collection may not exist yet in a fresh environment.
    }
  }
  return rows
}

async function reconcileTracks(tracks, contextLabel) {
  const safeTracks = Array.isArray(tracks) ? tracks : []
  const artistMap = new Map()
  const albumMap = new Map()

  safeTracks.forEach(track => {
    ;(track.artists || []).forEach(artist => {
      const id = String(artist.id || '')
      if (id && !artistMap.has(id)) artistMap.set(id, artist)
    })
    const albumId = String(track.albumId || '')
    if (albumId && !albumMap.has(albumId)) albumMap.set(albumId, track)
  })

  const artistIds = Array.from(artistMap.keys())
  const albumIds = Array.from(albumMap.keys())
  const [knownArtists, existingAlbums, existingAlbumCandidates] = await Promise.all([
    queryByIds('artist_candidates', 'artistId', artistIds, { _id: true, artistId: true, status: true }),
    queryByIds('albums', 'sourceId', albumIds, { _id: true, sourceId: true, source: true, approved: true }),
    queryByIds('album_candidates', 'sourceId', albumIds, { _id: true, sourceId: true, status: true }),
  ])

  const knownArtistIds = new Set(knownArtists.map(x => String(x.artistId || '')))
  const albumBySourceId = new Map(existingAlbums.map(x => [String(x.sourceId || ''), x]))
  const candidateAlbumIds = new Set(existingAlbumCandidates.map(x => String(x.sourceId || '')))

  const missingArtists = Array.from(artistMap.entries())
    .filter(([id]) => !knownArtistIds.has(id))
    .map(([id, artist]) => ({ id, artist }))

  const missingAlbums = Array.from(albumMap.entries())
    .filter(([id]) => !albumBySourceId.has(id) && !candidateAlbumIds.has(id))
    .map(([id, track]) => ({ id, track }))

  const now = db.serverDate()
  const artistWrites = missingArtists.map(({ id, artist }) => db.collection('artist_candidates').add({
    data: {
      artistId: id,
      artistName: artist.name || '',
      picUrl: artist.picUrl || '',
      albumSize: 0,
      foundFrom: 'feature_playlist',
      fromAlbum: contextLabel || '',
      round: 0,
      status: 'pending',
      addedAt: now,
      decidedAt: null,
    },
  }))

  const albumWrites = missingAlbums.map(async ({ id, track }) => {
    // albumMap only ever kept ONE representative track per album (the first one seen in the
    // playlist) — using that track's own per-song artist credits as the album's artist list wrongly
    // promotes a featured guest on that one song into a co-owner of the whole album whenever the
    // representative track happens to be a feature/collab. Fetch the album's own NetEase artist
    // list instead (same source resolveOwners trusts elsewhere); only fall back to the track's
    // primary artist — never its full credit list — if that live fetch fails.
    const albumArtists = await fetchAlbumArtists(id)
    const fallback = (track.artists || []).slice(0, 1)
      .map(x => ({ id: String(x.id || ''), name: String(x.name || '').trim() }))
      .filter(a => a.name)
    const resolved = (albumArtists && albumArtists.length) ? albumArtists : fallback
    const primary = resolved[0] || {}
    const artistIds = resolved.map(x => x.id).filter(Boolean)
    const artistNames = resolved.map(x => x.name).filter(Boolean)
    return db.collection('album_candidates').add({
      data: {
        title: track.albumName || '未知专辑',
        artist: artistNames.join(' / '),
        primaryArtist: primary.name || '',
        neteaseArtistId: primary.id ? String(primary.id) : null,
        artistIds,
        releaseYear: Number(track.albumReleaseYear || 0),
        coverUrl: track.coverUrl || '',
        trackCount: Number(track.albumTrackCount || 0),
        sourceId: id,
        source: 'netease',
        sourcePlatform: 'netease',
        sourceKey: `netease:${id}`,
        normalizedTitle: normalizeTitle(track.albumName),
        candidateReason: `来自专题歌单：${contextLabel || FEATURE_ID}`,
        status: 'pending',
        addedAt: now,
        decidedAt: null,
      },
    })
  })

  await Promise.allSettled([...artistWrites, ...albumWrites])

  const missingArtistIdSet = new Set(missingArtists.map(x => x.id))
  const resolvedTracks = safeTracks.map(track => {
    const album = albumBySourceId.get(String(track.albumId || ''))
    const missingArtistNames = (track.artists || [])
      .filter(artist => missingArtistIdSet.has(String(artist.id || '')))
      .map(artist => artist.name)
    return {
      ...track,
      barscopeAlbumId: album ? album._id : '',
      albumCatalogStatus: album ? 'linked' : 'pending',
      missingArtistNames,
    }
  })

  return {
    tracks: resolvedTracks,
    linkedAlbums: resolvedTracks.filter(x => x.barscopeAlbumId).length,
    pendingAlbums: missingAlbums.length,
    pendingArtists: missingArtists.length,
  }
}

async function importPlaylist(event, openId) {
  const creatorName = String(event.creatorName || '').trim()
  const playlistId = extractPlaylistId(event.playlistUrl || event.playlistId)
  if (!creatorName) return { success: false, error: 'creator_name_required' }
  if (!playlistId) return { success: false, error: 'invalid_playlist_url' }

  const playlist = await fetchPlaylist(playlistId)
  const reconciliation = await reconcileTracks(playlist.tracks, `${creatorName} · ${playlist.title}`)
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
    tracks: reconciliation.tracks,
    catalogSync: {
      linkedAlbums: reconciliation.linkedAlbums,
      pendingAlbums: reconciliation.pendingAlbums,
      pendingArtists: reconciliation.pendingArtists,
      syncedAt: now,
    },
    sourceType: 'editorial',
    editorialPriority: Number(event.editorialPriority || 100),
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
    return { success: true, updated: true, submissionId: id, playlist: publicMeta({ _id: id, ...payload }) }
  }

  const result = await db.collection('feature_playlist_submissions').add({
    data: { ...payload, createdAt: now },
  })
  return { success: true, updated: false, submissionId: result._id, playlist: publicMeta({ _id: result._id, ...payload }) }
}

async function submitPublicPlaylist(event, openId) {
  const playlistId = extractPlaylistId(event.playlistUrl || event.playlistId)
  if (!playlistId) return { success: false, error: 'invalid_playlist_url' }

  const existing = await db.collection('feature_playlist_submissions')
    .where({ featureId: FEATURE_ID, neteasePlaylistId: playlistId })
    .limit(1)
    .get()

  if (existing.data.length) {
    return { success: true, duplicate: true, playlist: publicMeta(existing.data[0]) }
  }

  const playlist = await fetchPlaylist(playlistId)
  const creatorName = String(playlist.creator?.nickname || '网易云用户').trim()
  const reconciliation = await reconcileTracks(playlist.tracks, `${creatorName} · ${playlist.title}`)
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
    tracks: reconciliation.tracks,
    catalogSync: {
      linkedAlbums: reconciliation.linkedAlbums,
      pendingAlbums: reconciliation.pendingAlbums,
      pendingArtists: reconciliation.pendingArtists,
      syncedAt: now,
    },
    sourceType: 'community',
    editorialPriority: 0,
    submittedBy: openId || '',
    updatedAt: now,
    createdAt: now,
  }

  const result = await db.collection('feature_playlist_submissions').add({ data: payload })
  return { success: true, duplicate: false, submissionId: result._id, playlist: publicMeta({ _id: result._id, ...payload }) }
}

async function listSubmissions() {
  const result = await db.collection('feature_playlist_submissions')
    .where({ featureId: FEATURE_ID })
    .orderBy('updatedAt', 'desc')
    .limit(100)
    .get()
  return { success: true, list: result.data }
}

async function listPublicSubmissions() {
  const result = await db.collection('feature_playlist_submissions')
    .where({ featureId: FEATURE_ID })
    .limit(100)
    .get()

  const list = result.data
    .map(publicMeta)
    .sort((a, b) => {
      if (a.isEditorial !== b.isEditorial) return a.isEditorial ? -1 : 1
      if (a.editorialPriority !== b.editorialPriority) return b.editorialPriority - a.editorialPriority
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
      return bTime - aTime
    })

  return {
    success: true,
    list,
    editorialCount: list.filter(item => item.isEditorial).length,
    communityCount: list.filter(item => !item.isEditorial).length,
  }
}

async function getPublicDetail(id) {
  if (!id) return { success: false, error: 'id_required' }
  const result = await db.collection('feature_playlist_submissions').doc(id).get()
  const item = result.data
  if (!item || item.featureId !== FEATURE_ID) return { success: false, error: 'playlist_not_found' }

  const reconciliation = await reconcileTracks(item.tracks || [], `${item.creatorName || ''} · ${item.playlistTitle || ''}`)
  const now = new Date()
  await db.collection('feature_playlist_submissions').doc(id).update({
    data: {
      tracks: reconciliation.tracks,
      catalogSync: {
        linkedAlbums: reconciliation.linkedAlbums,
        pendingAlbums: reconciliation.pendingAlbums,
        pendingArtists: reconciliation.pendingArtists,
        syncedAt: now,
      },
    },
  })

  return {
    success: true,
    playlist: {
      ...publicMeta(item),
      playlistDescription: item.playlistDescription || '',
      tracks: reconciliation.tracks,
      catalogSync: {
        linkedAlbums: reconciliation.linkedAlbums,
        pendingAlbums: reconciliation.pendingAlbums,
        pendingArtists: reconciliation.pendingArtists,
      },
    },
  }
}

async function removeSubmission(id) {
  if (!id) return { success: false, error: 'id_required' }
  await db.collection('feature_playlist_submissions').doc(id).remove()
  return { success: true }
}

async function setSourceType(id, sourceType) {
  if (!id) return { success: false, error: 'id_required' }
  if (sourceType !== 'editorial' && sourceType !== 'community') return { success: false, error: 'invalid_source_type' }
  const data = { sourceType, updatedAt: new Date() }
  // Community submissions carry no priority; give a promoted-to-editorial one the same default
  // importPlaylist uses so it doesn't silently sort behind every deliberately-imported list.
  if (sourceType === 'editorial') data.editorialPriority = 100
  await db.collection('feature_playlist_submissions').doc(id).update({ data })
  return { success: true }
}

exports.main = async (event) => {
  const action = event.action || 'list'
  const { OPENID: openId } = cloud.getWXContext()

  try {
    if (action === 'list_public') return await listPublicSubmissions()
    if (action === 'get_public_detail') return await getPublicDetail(event.id)
    if (action === 'submit_public') return await submitPublicPlaylist(event, openId)

    if (!openId || !(await checkAdmin(openId))) return { success: false, error: 'unauthorized' }
    if (action === 'import') return await importPlaylist(event, openId)
    if (action === 'list') return await listSubmissions()
    if (action === 'remove') return await removeSubmission(event.id)
    if (action === 'set_source_type') return await setSourceType(event.id, event.sourceType)
    return { success: false, error: 'unknown_action' }
  } catch (error) {
    console.error('[manageFeaturePlaylists]', action, error)
    return { success: false, error: error.message || 'unknown_error' }
  }
}
