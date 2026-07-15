const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s._\-·'’/]/g, '')
}

// NetEase marks an unmatched/unresolved artist with id 0 — still a real featuring credit with a
// real name, just without a resolvable artist page. `id || ''`-style coalescing treats 0 as falsy
// and silently drops these guests, so id must be read with a null/undefined check instead, and rows
// without a usable id are identified by normalized name rather than discarded.
function readGuestId(guest) {
  const raw = guest && (guest.id != null ? guest.id : guest.artistId)
  const idStr = String(raw != null ? raw : '').trim()
  return idStr && idStr !== '0' ? idStr : ''
}

function collabKey(id, nameKey) {
  return id ? `id:${id}` : `name:${nameKey}`
}

function addCount(map, id, name, increment = 1, currentId = '', currentNameKey = '') {
  const artistId = String(id || '').trim()
  const artistName = String(name || '').trim()
  if (!artistName || increment <= 0) return
  const nameKey = normalizeName(artistName)
  if ((artistId && artistId === currentId) || nameKey === currentNameKey) return
  const key = collabKey(artistId, nameKey)
  const row = map.get(key)
  if (row) row.count += increment
  else map.set(key, { key, artistId, name: artistName, count: increment, collected: false })
}

async function mapWithConcurrency(items, limit, fn) {
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++
      await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

// Ingestion (cloudCrawler) only stores lightweight album metadata — trackCount comes straight from
// NetEase's album summary, but the detailed per-track `tracks` array (which carries each track's
// featuring `guests`) is left empty until something triggers syncAlbumTracks. Today the only trigger
// is a user opening that album's detail page, so an artist whose albums nobody has opened yet has
// zero usable featuring data. Do the same lazy sync here (server-to-server, mirroring the
// cloudCrawlerDailyTrigger → cloudCrawler pattern) so a first-ever visit to the artist page still
// produces a real SIDE B instead of silently reporting nothing. Best-effort: a sync failure for one
// album just leaves it out of this computation rather than failing the whole request.
async function ensureTracksSynced(albums) {
  const pending = albums.filter(a => a && a.sourceId && (!Array.isArray(a.tracks) || !a.tracks.length)).slice(0, 30)
  if (!pending.length) return
  await mapWithConcurrency(pending, 6, async album => {
    try {
      const res = await cloud.callFunction({ name: 'syncAlbumTracks', data: { albumId: album._id } })
      const r = res.result || {}
      if (r.success) {
        album.tracks = r.tracks || []
        album.featuringGuests = r.featuringGuests || []
      }
    } catch (e) {
      // leave album.tracks as-is; this album is just skipped below
    }
  })
}

async function fetchCareerAlbums(artistId) {
  const key = String(artistId)
  const [ownerRes, coCreatorRes, legacyRes] = await Promise.all([
    db.collection('albums').where({ approved: true, ownerArtistIds: _.all([key]) }).limit(100).get(),
    db.collection('albums').where({ approved: true, ownerArtistIds: _.exists(false), artistIds: _.all([key]) }).limit(100).get(),
    db.collection('albums').where({ approved: true, ownerArtistIds: _.exists(false), neteaseArtistId: key }).limit(100).get(),
  ])
  const seen = new Set()
  return ownerRes.data.concat(coCreatorRes.data, legacyRes.data).filter(album => {
    if (!album || !album._id || seen.has(album._id)) return false
    seen.add(album._id)
    return true
  })
}

async function markCollected(rows) {
  const ids = [...new Set(rows.map(x => String(x.artistId)).filter(Boolean))].slice(0, 100)
  if (!ids.length) return rows
  const numericIds = ids.map(Number).filter(Number.isFinite)
  const [profilesByNetease, profilesByArtist, candidatesString, candidatesNumber] = await Promise.all([
    db.collection('artists').where({ neteaseArtistId: _.in(ids) }).field({ neteaseArtistId: true, artistId: true }).limit(100).get().catch(() => ({ data: [] })),
    db.collection('artists').where({ artistId: _.in(ids) }).field({ neteaseArtistId: true, artistId: true }).limit(100).get().catch(() => ({ data: [] })),
    db.collection('artist_candidates').where({ artistId: _.in(ids), status: 'approved' }).field({ artistId: true }).limit(100).get().catch(() => ({ data: [] })),
    numericIds.length ? db.collection('artist_candidates').where({ artistId: _.in(numericIds), status: 'approved' }).field({ artistId: true }).limit(100).get().catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
  ])
  const collected = new Set()
  ;[].concat(profilesByNetease.data || [], profilesByArtist.data || [], candidatesString.data || [], candidatesNumber.data || []).forEach(x => {
    if (x.neteaseArtistId != null) collected.add(String(x.neteaseArtistId))
    if (x.artistId != null) collected.add(String(x.artistId))
  })
  return rows.map(row => ({ ...row, collected: collected.has(String(row.artistId)) }))
}

exports.main = async event => {
  const artistId = String(event.artistId || '').trim()
  const artistName = String(event.artistName || '').trim()
  if (!artistId) return { success: false, error: 'missing artistId', list: [] }

  try {
    const albums = await fetchCareerAlbums(artistId)
    await ensureTracksSynced(albums)
    const counts = new Map()
    const currentNameKey = normalizeName(artistName)

    albums.forEach(album => {
      const tracks = Array.isArray(album.tracks) ? album.tracks : []
      const albumTrackCounts = new Map()

      tracks.forEach(track => {
        const seenThisTrack = new Set()
        const guests = Array.isArray(track.guests) ? track.guests : []
        guests.forEach(guest => {
          const id = readGuestId(guest)
          const name = String(guest && (guest.name || guest.artistName) || '').trim()
          if (!name) return
          const key = collabKey(id, normalizeName(name))
          if (seenThisTrack.has(key)) return
          seenThisTrack.add(key)
          albumTrackCounts.set(key, (albumTrackCounts.get(key) || 0) + 1)
          addCount(counts, id, name, 1, artistId, currentNameKey)
        })
      })

      // Backfill only missing appearances from the album-level summary. This handles older
      // records where some track.guests entries are incomplete without double-counting rows
      // already present at track level.
      if (Array.isArray(album.featuringGuests)) {
        album.featuringGuests.forEach(guest => {
          const id = readGuestId(guest)
          const name = String(guest && (guest.name || guest.artistName) || '').trim()
          if (!name) return
          const key = collabKey(id, normalizeName(name))
          const summaryCount = Number(guest && guest.count || 1)
          const trackCount = albumTrackCounts.get(key) || 0
          if (summaryCount > trackCount) addCount(counts, id, name, summaryCount - trackCount, artistId, currentNameKey)
        })
      }
    })

    let rows = await markCollected(Array.from(counts.values()))
    rows = rows.sort((a, b) => b.count - a.count || Number(b.collected) - Number(a.collected) || a.name.localeCompare(b.name)).slice(0, 10)

    return {
      success: true,
      list: rows,
      albumCount: albums.length,
      note: '仅统计生涯已收录专辑 Tracks 中的 Featuring 合作',
    }
  } catch (e) {
    return { success: false, error: e.message, list: [] }
  }
}
