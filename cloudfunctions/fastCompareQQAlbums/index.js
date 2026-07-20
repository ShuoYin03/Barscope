const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const ALBUM_FIELDS = {
  _id: true,
  title: true,
  sourceId: true,
  sourceKey: true,
  source: true,
  qqAlbumMid: true,
  qqAlbumId: true,
  neteaseArtistId: true,
  releaseDate: true,
  releaseYear: true,
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\[(（【]\s*explicit\s*[\])）】]/gi, '')
    .replace(/\bexplicit\b/gi, '')
    .replace(/[\s\-_·•:：()（）\[\]【】'"“”‘’.,，。!?！？&]/g, '')
}

function sourceKeyOf(item) {
  const source = String(item.sourcePlatform || item.source || 'qq').trim().toLowerCase() || 'qq'
  return String(item.sourceKey || `${source}:${String(item.sourceId || '').trim()}`)
}

function parseDate(value) {
  if (!value) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const text = String(value).trim()
  if (!text) return null
  const normalized = text.replace(/[./年]/g, '-').replace(/月/g, '-').replace(/日/g, '')
  const match = normalized.match(/((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})/)
  if (match) {
    const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    return Number.isNaN(d.getTime()) ? null : d
  }
  const d = new Date(text)
  return Number.isNaN(d.getTime()) ? null : d
}

function dayDiff(a, b) {
  const da = parseDate(a)
  const dbb = parseDate(b)
  if (!da || !dbb) return null
  return Math.abs(da.getTime() - dbb.getTime()) / 86400000
}

async function queryIn(collection, field, values, projection) {
  const unique = Array.from(new Set((values || []).map(v => String(v || '').trim()).filter(Boolean)))
  const rows = []
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100)
    if (!chunk.length) continue
    const r = await db.collection(collection).where({ [field]: _.in(chunk) }).field(projection).limit(100).get()
    rows.push(...(r.data || []))
  }
  return rows
}

async function getAllArtistAlbums(artistId) {
  const rows = []
  for (let offset = 0; ; offset += 100) {
    const r = await db.collection('albums').where({ neteaseArtistId: artistId }).field(ALBUM_FIELDS).skip(offset).limit(100).get()
    rows.push(...(r.data || []))
    if (!r.data || r.data.length < 100) break
  }
  return rows
}

async function catalogPage(event) {
  const offset = Math.max(0, Number(event.offset || 0))
  const limit = Math.max(1, Math.min(100, Number(event.limit || 100)))
  const r = await db.collection('albums')
    .field({ _id: true, title: true, releaseDate: true, releaseYear: true, neteaseArtistId: true, artist: true, primaryArtist: true })
    .skip(offset)
    .limit(limit)
    .get()
  return { success: true, offset, limit, rows: r.data || [], hasMore: (r.data || []).length === limit }
}

async function compareBatch(rawItems) {
  const items = (Array.isArray(rawItems) ? rawItems : []).slice(0, 200).map(raw => ({
    ...raw,
    sourceId: String(raw.sourceId || '').trim(),
    sourceKey: sourceKeyOf(raw),
    qqAlbumMid: String(raw.qqAlbumMid || raw.sourceId || '').trim(),
    neteaseArtistId: String(raw.neteaseArtistId || '').trim(),
    normalizedTitle: normalizeTitle(raw.title),
  })).filter(x => x.sourceId)

  if (!items.length) return { success: true, newItems: [], matched: [], existingCandidates: [] }

  const sourceKeys = items.map(x => x.sourceKey)
  const sourceIds = items.map(x => x.sourceId)
  const qqMids = items.map(x => x.qqAlbumMid)

  const [candidateByKey, candidateBySource, albumsByKey, albumsByQQMid, albumsBySource] = await Promise.all([
    queryIn('album_candidates', 'sourceKey', sourceKeys, { _id: true, sourceKey: true, sourceId: true, status: true, title: true }),
    queryIn('album_candidates', 'sourceId', sourceIds, { _id: true, sourceKey: true, sourceId: true, status: true, title: true }),
    queryIn('albums', 'sourceKey', sourceKeys, ALBUM_FIELDS),
    queryIn('albums', 'qqAlbumMid', qqMids, ALBUM_FIELDS),
    queryIn('albums', 'sourceId', sourceIds, ALBUM_FIELDS),
  ])

  const existingCandidateKeys = new Set()
  for (const row of [...candidateByKey, ...candidateBySource]) {
    if (row.sourceKey) existingCandidateKeys.add(String(row.sourceKey))
    if (row.sourceId) existingCandidateKeys.add(`source:${String(row.sourceId)}`)
  }

  const directAlbumMap = new Map()
  for (const row of [...albumsByKey, ...albumsByQQMid, ...albumsBySource]) {
    if (row.sourceKey) directAlbumMap.set(`key:${String(row.sourceKey)}`, row)
    if (row.qqAlbumMid) directAlbumMap.set(`qq:${String(row.qqAlbumMid)}`, row)
    if (row.sourceId) directAlbumMap.set(`source:${String(row.sourceId)}`, row)
  }

  const unresolved = items.filter(item => {
    if (existingCandidateKeys.has(item.sourceKey) || existingCandidateKeys.has(`source:${item.sourceId}`)) return false
    return !directAlbumMap.get(`key:${item.sourceKey}`) && !directAlbumMap.get(`qq:${item.qqAlbumMid}`) && !directAlbumMap.get(`source:${item.sourceId}`)
  })

  const artistIds = Array.from(new Set(unresolved.map(x => x.neteaseArtistId).filter(Boolean)))
  const artistAlbums = new Map()
  await Promise.all(artistIds.map(async artistId => {
    artistAlbums.set(artistId, await getAllArtistAlbums(artistId))
  }))

  const newItems = []
  const matched = []
  const existingCandidates = []

  for (const item of items) {
    if (existingCandidateKeys.has(item.sourceKey) || existingCandidateKeys.has(`source:${item.sourceId}`)) {
      existingCandidates.push({ sourceKey: item.sourceKey, title: item.title, artist: item.artist })
      continue
    }

    let album = directAlbumMap.get(`key:${item.sourceKey}`)
      || directAlbumMap.get(`qq:${item.qqAlbumMid}`)
      || directAlbumMap.get(`source:${item.sourceId}`)
    let matchType = album ? 'direct_platform_identity' : ''
    let matchedDateDiffDays = null

    const sameArtistAlbums = item.neteaseArtistId ? (artistAlbums.get(item.neteaseArtistId) || []) : []

    if (!album && item.normalizedTitle) {
      album = sameArtistAlbums.find(a => normalizeTitle(a.title) === item.normalizedTitle)
      if (album) matchType = 'normalized_title'
    }

    if (!album && item.releaseDate) {
      const dateHits = sameArtistAlbums
        .map(a => ({ album: a, diff: dayDiff(item.releaseDate, a.releaseDate) }))
        .filter(x => x.diff !== null && x.diff <= 3)
        .sort((a, b) => a.diff - b.diff)
      if (dateHits.length) {
        album = dateHits[0].album
        matchType = 'release_date_3d'
        matchedDateDiffDays = dateHits[0].diff
      }
    }

    if (album) {
      matched.push({
        sourceKey: item.sourceKey,
        qqTitle: item.title,
        qqArtist: item.artist,
        qqReleaseDate: item.releaseDate || '',
        barscopeAlbumId: album._id,
        barscopeTitle: album.title,
        neteaseReleaseDate: album.releaseDate || '',
        matchType,
        dateDiffDays: matchedDateDiffDays,
      })
    } else {
      newItems.push(item.sourceKey)
    }
  }

  return {
    success: true,
    total: items.length,
    newCount: newItems.length,
    matchedCount: matched.length,
    existingCandidateCount: existingCandidates.length,
    newItems,
    matched,
    existingCandidates,
  }
}

exports.main = async event => {
  try {
    if (event.action === 'catalogPage') return await catalogPage(event)
    return await compareBatch(event.candidates || [])
  } catch (e) {
    console.error('fastCompareQQAlbums failed', e)
    return { success: false, error: String(e && e.message || e) }
  }
}
