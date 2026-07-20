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

function normalizeName(v) {
  return String(v || '').trim().toLowerCase().replace(/[\s._\-·'’()（）\[\]【】]/g, '')
}

function ownerPairs(album) {
  if (Array.isArray(album.ownerArtists) && album.ownerArtists.length) {
    return album.ownerArtists
      .map(a => ({ id: String(a && (a.id || a.artistId) || ''), name: String(a && (a.name || a.artistName) || '').trim() }))
      .filter(a => a.id || a.name)
  }
  const ids = Array.isArray(album.ownerArtistIds) ? album.ownerArtistIds.map(String).filter(Boolean) : []
  if (ids.length) {
    const names = String(album.artist || album.primaryArtist || '').split('/').map(s => s.trim()).filter(Boolean)
    return ids.map((id, i) => ({ id, name: names[i] || (ids.length === 1 ? String(album.primaryArtist || album.artist || '').trim() : '') }))
  }
  if (album.neteaseArtistId || album.primaryArtist) {
    return [{ id: String(album.neteaseArtistId || ''), name: String(album.primaryArtist || album.artist || '').trim() }]
  }
  return []
}

async function scanMeta() {
  const albumCount = Number((await db.collection('albums').count()).total || 0)
  let artistCount = 0
  try { artistCount += Number((await db.collection('artist_candidates').where({ status: 'approved' }).count()).total || 0) } catch (e) {}
  try { artistCount += Number((await db.collection('artists').count()).total || 0) } catch (e) {}
  return { success: true, albumCount, artistCount, pageSize: 80 }
}

async function findExistingOwners(owners) {
  const ids = [...new Set(owners.map(o => String(o.id || '')).filter(Boolean))]
  const rawNames = [...new Set(owners.map(o => String(o.name || '').trim()).filter(Boolean))]
  const existingIds = new Set()
  const exactNameMap = new Map()
  const normalizedNameMap = new Map()

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    try {
      const r = await db.collection('artist_candidates').where({ status: 'approved', artistId: _.in(chunk) }).field({ _id:true, artistId:true, artistName:true }).limit(100).get()
      r.data.forEach(a => {
        if (a.artistId) existingIds.add(String(a.artistId))
        const raw = String(a.artistName || '').trim()
        if (raw) {
          exactNameMap.set(raw.toLowerCase(), a)
          normalizedNameMap.set(normalizeName(raw), a)
        }
      })
    } catch (e) {}
    try {
      const r = await db.collection('artists').where({ artistId: _.in(chunk) }).field({ _id:true, artistId:true, neteaseArtistId:true, name:true, artistName:true }).limit(100).get()
      r.data.forEach(a => {
        const id = String(a.artistId || a.neteaseArtistId || '')
        const raw = String(a.artistName || a.name || '').trim()
        if (id) existingIds.add(id)
        if (raw) {
          exactNameMap.set(raw.toLowerCase(), a)
          normalizedNameMap.set(normalizeName(raw), a)
        }
      })
    } catch (e) {}
  }

  // Query every owner name, not just the first 20. The old 20-name cap caused large false-positive batches.
  for (let i = 0; i < rawNames.length; i += 100) {
    const chunk = rawNames.slice(i, i + 100)
    try {
      const r = await db.collection('artist_candidates').where({ status: 'approved', artistName: _.in(chunk) }).field({ _id:true, artistId:true, artistName:true }).limit(100).get()
      r.data.forEach(a => {
        const raw = String(a.artistName || '').trim()
        if (!raw) return
        exactNameMap.set(raw.toLowerCase(), a)
        normalizedNameMap.set(normalizeName(raw), a)
      })
    } catch (e) {}
  }

  return { existingIds, exactNameMap, normalizedNameMap }
}

function addIssue(map, owner, album, extra = {}) {
  const key = owner.id || `name:${normalizeName(owner.name)}`
  if (!map.has(key)) {
    map.set(key, {
      artistId: owner.id || '',
      artistName: owner.name || '未知艺人',
      albumCount: 0,
      albumIds: [],
      albums: [],
      ...extra,
    })
  }
  const row = map.get(key)
  row.albumCount++
  row.albumIds.push(album._id)
  if (row.albums.length < 8) row.albums.push({ albumId: album._id, title: album.title || '', coverUrl: album.coverUrl || album.cover || '' })
}

async function scanPage(skip, limit) {
  const safeSkip = Math.max(0, Number(skip || 0))
  const safeLimit = Math.min(100, Math.max(20, Number(limit || 80)))
  const r = await db.collection('albums').skip(safeSkip).limit(safeLimit).get()
  const albums = (r.data || []).filter(a => a.approved !== false)
  const allOwners = []
  albums.forEach(a => allOwners.push(...ownerPairs(a)))
  const { existingIds, exactNameMap, normalizedNameMap } = await findExistingOwners(allOwners)

  const missingOwnership = []
  const missingArtistMap = new Map()
  const idMismatchMap = new Map()
  const suspectedMatchMap = new Map()
  let missingDescription = 0
  let missingCover = 0
  let missingReleaseDate = 0

  for (const album of albums) {
    if (!String(album.description || album.intro || '').trim()) missingDescription++
    if (!String(album.coverUrl || album.cover || '').trim()) missingCover++
    if (!String(album.releaseDate || album.publishTime || album.releaseYear || '').trim()) missingReleaseDate++

    const owners = ownerPairs(album)
    if (!owners.length) {
      missingOwnership.push({
        albumId: album._id,
        title: album.title || '',
        artist: album.artist || album.primaryArtist || '',
        coverUrl: album.coverUrl || album.cover || '',
        sourceId: album.sourceId || '',
      })
      continue
    }

    owners.forEach(owner => {
      const id = String(owner.id || '')
      const rawLower = String(owner.name || '').trim().toLowerCase()
      const normalized = normalizeName(owner.name)

      if (id && existingIds.has(id)) return

      const exact = rawLower ? exactNameMap.get(rawLower) : null
      if (exact) {
        addIssue(idMismatchMap, owner, album, {
          matchedArtistId: String(exact.artistId || exact.neteaseArtistId || ''),
          matchedArtistName: String(exact.artistName || exact.name || owner.name || ''),
          matchedArtistDocId: String(exact._id || ''),
        })
        return
      }

      const suspected = normalized ? normalizedNameMap.get(normalized) : null
      if (suspected) {
        addIssue(suspectedMatchMap, owner, album, {
          matchedArtistId: String(suspected.artistId || suspected.neteaseArtistId || ''),
          matchedArtistName: String(suspected.artistName || suspected.name || ''),
          matchedArtistDocId: String(suspected._id || ''),
        })
        return
      }

      if (!id && !normalized) return
      addIssue(missingArtistMap, owner, album)
    })
  }

  return {
    success: true,
    skip: safeSkip,
    nextSkip: safeSkip + (r.data || []).length,
    fetched: (r.data || []).length,
    scanned: albums.length,
    missingDescription,
    missingCover,
    missingReleaseDate,
    missingOwnership,
    missingArtists: Array.from(missingArtistMap.values()),
    idMismatches: Array.from(idMismatchMap.values()),
    suspectedMatches: Array.from(suspectedMatchMap.values()),
  }
}

async function sendArtistsToReview(items) {
  const validItems = (items || []).filter(x => x && (x.artistId || x.artistName))
  if (!validItems.length) return { success: true, inserted: 0, skipped: 0 }
  const existingIds = new Set()
  const ids = [...new Set(validItems.map(x => String(x.artistId || '')).filter(Boolean))]
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    try {
      const r = await db.collection('artist_candidates').where({ artistId: _.in(chunk) }).field({ artistId: true }).limit(chunk.length).get()
      r.data.forEach(x => existingIds.add(String(x.artistId)))
    } catch (e) {}
  }

  let inserted = 0
  let skipped = 0
  for (const item of validItems) {
    if (item.artistId && existingIds.has(String(item.artistId))) { skipped++; continue }
    try {
      await db.collection('artist_candidates').add({ data: {
        artistId: String(item.artistId || ''),
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
      } })
      inserted++
    } catch (e) { skipped++ }
  }
  return { success: true, inserted, skipped }
}

exports.main = async event => {
  try {
    const { OPENID: openId } = cloud.getWXContext()
    if (!openId || !(await checkAdmin(openId))) return { success: false, error: 'unauthorized' }
    const action = String(event.action || 'scan_meta')
    if (action === 'scan_meta') return await scanMeta()
    if (action === 'scan_page') return await scanPage(event.skip, event.limit)
    if (action === 'send_artists_to_review') return await sendArtistsToReview(event.items || [])
    return { success: false, error: 'unknown_action' }
  } catch (e) {
    console.error('[manageDataDiagnostics]', e)
    return { success: false, error: 'scan_failed', detail: String(e && (e.message || e.errMsg) || e) }
  }
}
