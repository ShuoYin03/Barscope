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

  // Candidate files are grouped by artist, so this is usually only a handful of DB reads per 100 items.
  const artistIds = Array.from(new Set(unresolved.map(x => x.neteaseArtistId).filter(Boolean)))
  const artistAlbums = new Map()
  await Promise.all(artistIds.map(async artistId => {
    const r = await db.collection('albums')
      .where({ neteaseArtistId: artistId })
      .field(ALBUM_FIELDS)
      .limit(100)
      .get()
    artistAlbums.set(artistId, r.data || [])
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

    if (!album && item.neteaseArtistId && item.normalizedTitle) {
      album = (artistAlbums.get(item.neteaseArtistId) || []).find(a => normalizeTitle(a.title) === item.normalizedTitle)
    }

    if (album) {
      matched.push({
        sourceKey: item.sourceKey,
        qqTitle: item.title,
        qqArtist: item.artist,
        barscopeAlbumId: album._id,
        barscopeTitle: album.title,
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
    return await compareBatch(event.candidates || [])
  } catch (e) {
    console.error('fastCompareQQAlbums failed', e)
    return { success: false, error: String(e && e.message || e) }
  }
}
