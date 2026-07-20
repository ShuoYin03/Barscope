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

async function resolveCloudAvatarUrl(avatarUrl) {
  const url = String(avatarUrl || '')
  if (!url.startsWith('cloud://')) return url
  try {
    const r = await cloud.getTempFileURL({ fileList: [url] })
    const hit = (r.fileList || [])[0]
    return (hit && hit.status === 0 && hit.tempFileURL) || url
  } catch (e) {
    return url
  }
}

function pickBestUserDoc(rows) {
  return rows.reduce((acc, doc) => (!acc || (!acc.avatarUrl && doc.avatarUrl)) ? doc : acc, null)
}

async function findBarscopeCreatorBySubmitter(openId) {
  if (!openId) return null
  try {
    const res = await db.collection('users').where({ openId }).limit(5).get()
    const rows = res.data || []
    if (!rows.length) return null
    const best = pickBestUserDoc(rows)
    const avatarUrl = await resolveCloudAvatarUrl(best.avatarUrl)
    return { openId, nickName: best.nickName || '', avatarUrl, matchType: 'submitter' }
  } catch (e) {
    return null
  }
}

async function findBarscopeCreatorByName(name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return null
  try {
    const res = await db.collection('users').where({ nickName: trimmed }).limit(5).get()
    const rows = res.data || []
    if (!rows.length) return null
    const best = pickBestUserDoc(rows)
    if (!best.openId) return null
    const avatarUrl = await resolveCloudAvatarUrl(best.avatarUrl)
    return { openId: best.openId, nickName: best.nickName || trimmed, avatarUrl, matchType: 'nickname' }
  } catch (e) {
    return null
  }
}

async function resolveBarscopeCreator(item) {
  if (item.isOwnPlaylist) {
    const bySubmitter = await findBarscopeCreatorBySubmitter(item.submittedBy)
    if (bySubmitter) return bySubmitter
  }
  return await findBarscopeCreatorByName(item.creatorName)
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
    } catch (e) {}
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

  // Playlist imports must never auto-create artist review candidates. We still keep track of
  // unresolved artist names for diagnostics/UI, but only an explicit admin action or the dedicated
  // data-diagnostics/manual-artist flow may enqueue a rapper for review.
  const missingArtists = Array.from(artistMap.entries())
    .filter(([id]) => !knownArtistIds.has(id))
    .map(([id, artist]) => ({ id, artist }))

  const missingAlbums = Array.from(albumMap.entries())
    .filter(([id]) => !albumBySourceId.has(id) && !candidateAlbumIds.has(id))
    .map(([id, track]) => ({ id, track }))

  const now = db.serverDate()
  const albumWrites = missingAlbums.map(async ({ id, track }) => {
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

  await Promise.allSettled(albumWrites)

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
    // informational only: these artists are unresolved, but nothing is automatically queued.
    pendingArtists: 0,
    unresolvedArtists: missingArtists.length,
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
    linkedAlbumCount: reconciliation.linkedAlbums,
    pendingAlbumCount: reconciliation.pendingAlbums,
    pendingArtistCount: 0,
    unresolvedArtistCount: reconciliation.unresolvedArtists || 0,
    sourceType: event.sourceType === 'community' ? 'community' : 'editorial',
    editorialPriority: Number(event.editorialPriority || 100),
    importedBy: openId,
    updatedAt: now,
  }

  const existing = await db.collection('feature_playlist_submissions').where({ featureId: FEATURE_ID, neteasePlaylistId: playlistId }).limit(1).get()
  if (existing.data.length) {
    await db.collection('feature_playlist_submissions').doc(existing.data[0]._id).update({ data: payload })
    return { success: true, updated: true, id: existing.data[0]._id, ...reconciliation }
  }

  const result = await db.collection('feature_playlist_submissions').add({ data: { ...payload, createdAt: now } })
  return { success: true, updated: false, id: result._id, ...reconciliation }
}

async function submitPublic(event, openId) {
  if (!openId) return { success: false, error: 'login_required' }
  const playlistId = extractPlaylistId(event.playlistUrl || event.playlistId)
  if (!playlistId) return { success: false, error: 'invalid_playlist_url' }

  const playlist = await fetchPlaylist(playlistId)
  const existing = await db.collection('feature_playlist_submissions').where({ featureId: FEATURE_ID, neteasePlaylistId: playlistId }).limit(1).get()
  if (existing.data.length) return { success: false, error: 'playlist_already_exists' }

  const creatorName = String(event.creatorName || playlist.creator?.nickname || '网易云用户').trim()
  const reconciliation = await reconcileTracks(playlist.tracks, `${creatorName} · ${playlist.title}`)
  const now = new Date()
  const payload = {
    featureId: FEATURE_ID,
    creatorName,
    submittedBy: openId,
    isOwnPlaylist: !!event.isOwnPlaylist,
    neteasePlaylistId: playlistId,
    neteasePlaylistUrl: `https://music.163.com/#/playlist?id=${playlistId}`,
    playlistTitle: playlist.title,
    playlistDescription: playlist.description,
    playlistCoverUrl: playlist.coverUrl,
    neteaseCreator: playlist.creator,
    trackCount: playlist.trackCount,
    tracks: reconciliation.tracks,
    linkedAlbumCount: reconciliation.linkedAlbums,
    pendingAlbumCount: reconciliation.pendingAlbums,
    pendingArtistCount: 0,
    unresolvedArtistCount: reconciliation.unresolvedArtists || 0,
    sourceType: 'community',
    editorialPriority: 0,
    importedBy: openId,
    createdAt: now,
    updatedAt: now,
  }
  const result = await db.collection('feature_playlist_submissions').add({ data: payload })
  return { success: true, id: result._id, ...reconciliation }
}

async function listPublic() {
  const result = await db.collection('feature_playlist_submissions').where({ featureId: FEATURE_ID }).limit(100).get()
  const rows = await Promise.all((result.data || []).filter(item => !item.statsRecord).map(async item => {
    const creator = await resolveBarscopeCreator(item)
    return { ...publicMeta(item), barscopeCreator: creator }
  }))
  return { success: true, list: rows }
}

async function getPublicDetail(id) {
  const result = await db.collection('feature_playlist_submissions').doc(id).get()
  const item = result.data
  if (!item || item.statsRecord) return { success: false, error: 'not_found' }
  const creator = await resolveBarscopeCreator(item)
  return { success: true, item: { ...item, barscopeCreator: creator } }
}

async function removePlaylist(id, openId) {
  if (!(await checkAdmin(openId))) return { success: false, error: 'unauthorized' }
  if (!id) return { success: false, error: 'missing_id' }
  await db.collection('feature_playlist_submissions').doc(id).remove()
  return { success: true }
}

async function setSourceType(id, sourceType, openId) {
  if (!(await checkAdmin(openId))) return { success: false, error: 'unauthorized' }
  if (!id) return { success: false, error: 'missing_id' }
  const normalized = sourceType === 'community' ? 'community' : 'editorial'
  await db.collection('feature_playlist_submissions').doc(id).update({
    data: {
      sourceType: normalized,
      editorialPriority: normalized === 'editorial' ? 100 : 0,
      updatedAt: new Date(),
    },
  })
  return { success: true, sourceType: normalized }
}

exports.main = async event => {
  try {
    const { OPENID: openId } = cloud.getWXContext()
    const action = String(event.action || 'import')

    if (action === 'import') {
      if (!(await checkAdmin(openId))) return { success: false, error: 'unauthorized' }
      return await importPlaylist(event, openId)
    }
    if (action === 'submit_public') return await submitPublic(event, openId)
    if (action === 'list_public') return await listPublic()
    if (action === 'get_public_detail') return await getPublicDetail(event.id)
    if (action === 'remove') return await removePlaylist(event.id, openId)
    if (action === 'set_source_type') return await setSourceType(event.id, event.sourceType, openId)
    return { success: false, error: 'unknown_action' }
  } catch (e) {
    console.error('[manageFeaturePlaylists]', e)
    return { success: false, error: e.message || 'internal_error' }
  }
}
