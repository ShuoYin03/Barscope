const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

async function checkAdmin(openId) {
  if (!openId) return false
  try {
    const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
    return r.data.length > 0
  } catch (e) { return false }
}

async function fetchAll(collection, where = {}) {
  const q = db.collection(collection).where(where)
  const total = Number((await q.count()).total || 0)
  const out = []
  for (let i = 0; i < total; i += 100) {
    const r = await q.skip(i).limit(100).get()
    out.push(...(r.data || []))
  }
  return out
}

function ownerPairs(album) {
  if (Array.isArray(album.ownerArtists) && album.ownerArtists.length) {
    return album.ownerArtists.map(a => ({ id: String(a && a.id || ''), name: String(a && a.name || '').trim() })).filter(a => a.id || a.name)
  }
  const ids = Array.isArray(album.ownerArtistIds) ? album.ownerArtistIds.map(String) : []
  if (ids.length) {
    const names = String(album.artist || album.primaryArtist || '').split('/').map(s => s.trim()).filter(Boolean)
    return ids.map((id, i) => ({ id, name: names[i] || (ids.length === 1 ? String(album.primaryArtist || '').trim() : '') }))
  }
  if (album.neteaseArtistId || album.primaryArtist) return [{ id: String(album.neteaseArtistId || ''), name: String(album.primaryArtist || '').trim() }]
  return []
}

async function scan() {
  const [albums, approvedCandidates] = await Promise.all([
    fetchAll('albums', { approved: true }),
    fetchAll('artist_candidates', { status: 'approved' }).catch(() => []),
  ])
  const approvedIds = new Set(approvedCandidates.map(a => String(a.artistId || '')).filter(Boolean))
  try {
    const artists = await fetchAll('artists', {})
    artists.forEach(a => {
      const id = String(a.artistId || a.neteaseArtistId || a.id || '')
      if (id) approvedIds.add(id)
    })
  } catch (e) {}

  const missingOwnership = []
  const missingArtistMap = new Map()
  let missingDescription = 0
  let missingCover = 0
  let missingReleaseDate = 0

  for (const album of albums) {
    if (!String(album.description || '').trim()) missingDescription++
    if (!String(album.coverUrl || '').trim()) missingCover++
    if (!String(album.releaseDate || '').trim()) missingReleaseDate++

    const owners = ownerPairs(album)
    if (!owners.length || !owners.some(o => o.id || o.name)) {
      missingOwnership.push({
        albumId: album._id,
        title: album.title || '',
        artist: album.artist || album.primaryArtist || '',
        coverUrl: album.coverUrl || '',
        sourceId: album.sourceId || '',
      })
      continue
    }

    owners.forEach(owner => {
      if (!owner.id || approvedIds.has(owner.id)) return
      if (!missingArtistMap.has(owner.id)) {
        missingArtistMap.set(owner.id, {
          artistId: owner.id,
          artistName: owner.name || '未知艺人',
          albumCount: 0,
          albumIds: [],
          albums: [],
        })
      }
      const row = missingArtistMap.get(owner.id)
      row.albumCount++
      row.albumIds.push(album._id)
      if (row.albums.length < 5) row.albums.push({ albumId: album._id, title: album.title || '', coverUrl: album.coverUrl || '' })
    })
  }

  const missingArtists = Array.from(missingArtistMap.values()).sort((a, b) => b.albumCount - a.albumCount || a.artistName.localeCompare(b.artistName))
  const issueCount = missingOwnership.length + missingArtists.length + missingDescription + missingCover + missingReleaseDate
  const healthScore = albums.length ? Math.max(0, Math.round((1 - issueCount / Math.max(albums.length * 4, 1)) * 1000) / 10) : 100

  return {
    success: true,
    summary: {
      healthScore,
      albumCount: albums.length,
      artistCount: approvedIds.size,
      missingOwnership: missingOwnership.length,
      missingArtists: missingArtists.length,
      missingDescription,
      missingCover,
      missingReleaseDate,
    },
    missingOwnership,
    missingArtists,
  }
}

async function sendArtistsToReview(items) {
  const ids = [...new Set((items || []).map(x => String(x.artistId || '')).filter(Boolean))]
  if (!ids.length) return { success: true, inserted: 0, skipped: 0 }
  const existing = new Set()
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    try {
      const r = await db.collection('artist_candidates').where({ artistId: _.in(chunk) }).field({ artistId: true }).limit(chunk.length).get()
      r.data.forEach(x => existing.add(String(x.artistId)))
    } catch (e) {}
  }
  const toInsert = (items || []).filter(x => x.artistId && !existing.has(String(x.artistId)))
  let inserted = 0
  for (const item of toInsert) {
    try {
      await db.collection('artist_candidates').add({
        data: {
          artistId: String(item.artistId),
          artistName: String(item.artistName || '未知艺人'),
          picUrl: item.picUrl || '',
          albumSize: Number(item.albumCount || 0),
          fansSize: 0,
          foundFrom: 'data_diagnostics',
          fromAlbum: (item.albums && item.albums[0] && item.albums[0].title) || '',
          round: 0,
          status: 'pending',
          addedAt: db.serverDate(),
          decidedAt: null,
        },
      })
      inserted++
    } catch (e) {}
  }
  return { success: true, inserted, skipped: ids.length - inserted }
}

exports.main = async event => {
  const { OPENID: openId } = cloud.getWXContext()
  if (!openId || !(await checkAdmin(openId))) return { success: false, error: 'unauthorized' }
  const action = String(event.action || 'scan')
  if (action === 'scan') return scan()
  if (action === 'send_artists_to_review') return sendArtistsToReview(event.items || [])
  return { success: false, error: 'unknown_action' }
}
