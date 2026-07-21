const cloud = require('wx-server-sdk')
const https = require('https')
const { checkAdmin } = require('./_shared/auth')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function normalizeName(v) {
  return String(v || '').trim().toLowerCase().replace(/[\s._\-·'’()（）\[\]【】]/g, '')
}

function normalizeArtistId(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return /^-?\d+$/.test(raw) ? String(Number(raw)) : raw
}

function idVariants(values) {
  const strings = []
  const numbers = []
  const seenStrings = new Set()
  const seenNumbers = new Set()
  ;(values || []).forEach(value => {
    const raw = String(value || '').trim()
    if (!raw) return
    const normalized = normalizeArtistId(raw)
    if (!seenStrings.has(normalized)) { seenStrings.add(normalized); strings.push(normalized) }
    if (/^-?\d+$/.test(raw)) {
      const n = Number(raw)
      if (Number.isSafeInteger(n) && !seenNumbers.has(n)) { seenNumbers.add(n); numbers.push(n) }
    }
  })
  return { strings, numbers }
}

function ownerPairs(album) {
  if (Array.isArray(album.ownerArtists) && album.ownerArtists.length) {
    return album.ownerArtists
      .map(a => ({ id: normalizeArtistId(a && (a.id || a.artistId)), name: String(a && (a.name || a.artistName) || '').trim() }))
      .filter(a => a.id || a.name)
  }
  const ids = Array.isArray(album.ownerArtistIds) ? album.ownerArtistIds.map(normalizeArtistId).filter(Boolean) : []
  if (ids.length) {
    const names = String(album.artist || album.primaryArtist || '').split('/').map(s => s.trim()).filter(Boolean)
    return ids.map((id, i) => ({ id, name: names[i] || (ids.length === 1 ? String(album.primaryArtist || album.artist || '').trim() : '') }))
  }
  if (album.neteaseArtistId || album.primaryArtist) {
    return [{ id: normalizeArtistId(album.neteaseArtistId), name: String(album.primaryArtist || album.artist || '').trim() }]
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

function collectArtist(mapSet, exactNameMap, normalizedNameMap, row) {
  if (!row) return
  const ids = [row.artistId, row.neteaseArtistId, row.id].filter(v => v !== undefined && v !== null && String(v).trim())
  ids.forEach(id => mapSet.add(normalizeArtistId(id)))
  const raw = String(row.artistName || row.name || '').trim()
  if (raw) {
    exactNameMap.set(raw.toLowerCase(), row)
    normalizedNameMap.set(normalizeName(raw), row)
  }
}

async function queryByIdVariants(collection, field, variants, extraWhere = {}) {
  const rows = []
  const seen = new Set()
  const batches = []
  if (variants.strings.length) batches.push(variants.strings)
  if (variants.numbers.length) batches.push(variants.numbers)
  for (const values of batches) {
    for (let i = 0; i < values.length; i += 100) {
      const chunk = values.slice(i, i + 100)
      try {
        const where = { ...extraWhere, [field]: _.in(chunk) }
        const r = await db.collection(collection).where(where).limit(100).get()
        ;(r.data || []).forEach(row => {
          const key = String(row._id || `${field}:${row[field]}`)
          if (!seen.has(key)) { seen.add(key); rows.push(row) }
        })
      } catch (e) {}
    }
  }
  return rows
}

async function findExistingOwners(owners) {
  const ids = [...new Set(owners.map(o => normalizeArtistId(o.id)).filter(Boolean))]
  const rawNames = [...new Set(owners.map(o => String(o.name || '').trim()).filter(Boolean))]
  const variants = idVariants(ids)
  const existingIds = new Set()
  const exactNameMap = new Map()
  const normalizedNameMap = new Map()

  const candidateRows = await queryByIdVariants('artist_candidates', 'artistId', variants, { status: 'approved' })
  candidateRows.forEach(a => collectArtist(existingIds, exactNameMap, normalizedNameMap, a))

  const artistRows = [
    ...(await queryByIdVariants('artists', 'artistId', variants)),
    ...(await queryByIdVariants('artists', 'neteaseArtistId', variants)),
  ]
  artistRows.forEach(a => collectArtist(existingIds, exactNameMap, normalizedNameMap, a))

  for (let i = 0; i < rawNames.length; i += 100) {
    const chunk = rawNames.slice(i, i + 100)
    try {
      const r = await db.collection('artist_candidates').where({ status: 'approved', artistName: _.in(chunk) }).limit(100).get()
      ;(r.data || []).forEach(a => collectArtist(existingIds, exactNameMap, normalizedNameMap, a))
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
      missingOwnership.push({ albumId: album._id, title: album.title || '', artist: album.artist || album.primaryArtist || '', coverUrl: album.coverUrl || album.cover || '', sourceId: album.sourceId || '' })
      continue
    }

    owners.forEach(owner => {
      const id = normalizeArtistId(owner.id)
      const rawLower = String(owner.name || '').trim().toLowerCase()
      const normalized = normalizeName(owner.name)

      if (id && existingIds.has(id)) return

      const exact = rawLower ? exactNameMap.get(rawLower) : null
      if (exact) {
        addIssue(idMismatchMap, owner, album, {
          matchedArtistId: normalizeArtistId(exact.artistId || exact.neteaseArtistId || ''),
          matchedArtistName: String(exact.artistName || exact.name || owner.name || ''),
          matchedArtistDocId: String(exact._id || ''),
        })
        return
      }

      const suspected = normalized ? normalizedNameMap.get(normalized) : null
      if (suspected) {
        addIssue(suspectedMatchMap, owner, album, {
          matchedArtistId: normalizeArtistId(suspected.artistId || suspected.neteaseArtistId || ''),
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

function hashString(str) {
  let hash = 5381
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  return hash
}

function candidateArtistId(item) {
  const raw = String(item.artistId || '').trim()
  if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw)
  const name = String(item.artistName || '').trim()
  return -Math.abs(hashString(name.toLowerCase().replace(/\s/g, ''))) || -Date.now()
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { resolve(null) } })
    })
    req.on('error', reject)
    req.setTimeout(2200, () => { req.destroy(); reject(new Error('网易云请求超时')) })
  })
}

async function fetchNeteaseArtist(item) {
  const artistId = candidateArtistId(item)
  const requestedName = String(item.artistName || '').trim()
  if (!(artistId > 0)) return null
  try {
    const data = await getJson(`https://music.163.com/api/artist/albums/${artistId}?offset=0&limit=1`)
    const artist = data && data.artist
    if (artist && artist.id) {
      const avatar = artist.picUrl || artist.img1v1Url || ''
      return {
        artistId: Number(artist.id),
        artistName: String(artist.name || requestedName),
        picUrl: avatar,
        avatarUrl: avatar,
        coverUrl: avatar,
        backgroundUrl: avatar,
        heroImageUrl: avatar,
        albumSize: Number(artist.albumSize || item.albumCount || 0),
        musicSize: Number(artist.musicSize || 0),
        fansSize: Number(artist.fansCnt || 0),
        neteaseLinked: true,
      }
    }
  } catch (e) {}

  try {
    const search = await getJson(`https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(requestedName)}&type=100&offset=0&total=true&limit=10`)
    const artists = (search && search.result && search.result.artists) || []
    const normalized = normalizeName(requestedName)
    const exact = artists.find(a => normalizeName(a && a.name) === normalized && Number(a && a.id) === artistId)
      || artists.find(a => Number(a && a.id) === artistId)
      || artists.find(a => normalizeName(a && a.name) === normalized)
    if (exact && exact.id) {
      const avatar = exact.picUrl || exact.img1v1Url || ''
      return {
        artistId: Number(exact.id),
        artistName: String(exact.name || requestedName),
        picUrl: avatar,
        avatarUrl: avatar,
        coverUrl: avatar,
        backgroundUrl: avatar,
        heroImageUrl: avatar,
        albumSize: Number(exact.albumSize || item.albumCount || 0),
        musicSize: Number(exact.musicSize || 0),
        fansSize: 0,
        neteaseLinked: true,
      }
    }
  } catch (e) {}
  return null
}

async function sendArtistsToReview(items, openId) {
  const validItems = (items || []).filter(x => x && String(x.artistName || '').trim()).slice(0, 12)
  if (!validItems.length) return { success: true, inserted: 0, skipped: 0, failed: 0, enriched: 0 }

  const targetIds = validItems.map(candidateArtistId)
  const variants = idVariants(targetIds)
  const existingRows = await queryByIdVariants('artist_candidates', 'artistId', variants)
  const existingIds = new Set(existingRows.map(x => normalizeArtistId(x.artistId)).filter(Boolean))
  const toInsert = validItems.filter(item => !existingIds.has(normalizeArtistId(candidateArtistId(item))))

  const enrichments = await Promise.all(toInsert.map(item => fetchNeteaseArtist(item).catch(() => null)))
  const now = db.serverDate()
  const ops = toInsert.map((item, index) => {
    const requestedId = candidateArtistId(item)
    const enriched = enrichments[index]
    const artistId = enriched && enriched.artistId ? enriched.artistId : requestedId
    const hasRealNeteaseId = artistId > 0
    const name = String((enriched && enriched.artistName) || item.artistName || '未知艺人').trim()
    const avatar = String((enriched && (enriched.avatarUrl || enriched.picUrl)) || '')
    return db.collection('artist_candidates').add({ data: {
      artistId,
      artistName: name,
      picUrl: avatar,
      avatarUrl: avatar,
      coverUrl: String((enriched && enriched.coverUrl) || avatar),
      backgroundUrl: String((enriched && enriched.backgroundUrl) || avatar),
      heroImageUrl: String((enriched && enriched.heroImageUrl) || avatar),
      albumSize: Number((enriched && enriched.albumSize) || item.albumCount || 0),
      musicSize: Number((enriched && enriched.musicSize) || 0),
      fansSize: Number((enriched && enriched.fansSize) || 0),
      roles: ['rapper'],
      foundFrom: 'data_diagnostics',
      fromAlbum: (item.albums && item.albums[0] && item.albums[0].title) || '',
      round: 999,
      status: 'pending',
      requestSource: hasRealNeteaseId ? 'data-diagnostics-owner' : 'data-diagnostics-manual',
      requesterOpenId: openId,
      requestedName: String(item.artistName || name),
      manualEntry: !hasRealNeteaseId,
      needsProfileCompletion: !avatar,
      neteaseLinked: !!(enriched && enriched.neteaseLinked),
      linkedAlbumIds: Array.isArray(item.albumIds) ? item.albumIds.slice(0, 100) : [],
      addedAt: now,
      decidedAt: null,
    } })
  })

  const results = await Promise.allSettled(ops)
  const inserted = results.filter(r => r.status === 'fulfilled').length
  const failed = results.filter(r => r.status === 'rejected').length
  const enriched = enrichments.filter(Boolean).length
  return { success: true, inserted, skipped: validItems.length - toInsert.length, failed, enriched }
}

exports.main = async event => {
  try {
    const { OPENID: openId } = cloud.getWXContext()
    if (!openId || !(await checkAdmin(openId))) return { success: false, error: 'unauthorized' }
    const action = String(event.action || 'scan_meta')
    if (action === 'scan_meta') return await scanMeta()
    if (action === 'scan_page') return await scanPage(event.skip, event.limit)
    if (action === 'send_artists_to_review') return await sendArtistsToReview(event.items || [], openId)
    return { success: false, error: 'unknown_action' }
  } catch (e) {
    console.error('[manageDataDiagnostics]', e)
    return { success: false, error: 'scan_failed', detail: String(e && (e.message || e.errMsg) || e) }
  }
}