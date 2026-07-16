const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const PAGE_SIZE = 1000

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const dryRun = event.dryRun !== false

  try {
    const isAdmin = await checkAdmin(OPENID)
    if (!isAdmin) return { success: false, error: 'unauthorized' }

    const albums = await fetchAllAlbums()
    const groups = buildDuplicateGroups(albums)

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        scanned: albums.length,
        duplicateGroups: groups.length,
        wouldRemove: groups.reduce((sum, g) => sum + g.remove.length, 0),
        samples: groups.slice(0, 10).map(toSummary),
      }
    }

    let removed = 0
    let reviewsMoved = 0
    let favoritesMoved = 0
    const errors = []

    for (const group of groups) {
      const keep = group.keep
      const allItems = [keep, ...group.remove]

      // Preserve every artist association before deleting duplicate documents.
      try {
        const mergedArtistIds = Array.from(new Set(allItems.flatMap(a => [
          ...(Array.isArray(a.artistIds) ? a.artistIds : []),
          a.neteaseArtistId,
        ]).filter(Boolean).map(String)))
        const mergedOwnerArtistIds = Array.from(new Set(allItems.flatMap(a =>
          Array.isArray(a.ownerArtistIds) ? a.ownerArtistIds : []
        ).filter(Boolean).map(String)))
        const patch = {}
        if (mergedArtistIds.length) patch.artistIds = mergedArtistIds
        if (mergedOwnerArtistIds.length) patch.ownerArtistIds = mergedOwnerArtistIds
        if (Object.keys(patch).length) await db.collection('albums').doc(keep._id).update({ data: patch })
      } catch (e) {
        errors.push(`merge ownership ${keep._id}: ${e.message}`)
      }

      for (const dup of group.remove) {
        try {
          const reviewRes = await db.collection('reviews')
            .where({ albumId: dup._id })
            .update({ data: { albumId: keep._id, albumTitle: keep.title || dup.title || '' } })
          reviewsMoved += (reviewRes.stats && reviewRes.stats.updated) || 0
        } catch (e) {
          errors.push(`move reviews ${dup._id}: ${e.message}`)
        }

        try {
          const favRes = await db.collection('favorites')
            .where({ albumId: dup._id })
            .update({ data: { albumId: keep._id } })
          favoritesMoved += (favRes.stats && favRes.stats.updated) || 0
        } catch (e) {
          errors.push(`move favorites ${dup._id}: ${e.message}`)
        }

        try {
          await db.collection('albums').doc(dup._id).remove()
          removed += 1
        } catch (e) {
          errors.push(`remove album ${dup._id}: ${e.message}`)
        }
      }

      try {
        await recalcAlbumScore(keep._id)
      } catch (e) {
        errors.push(`recalc ${keep._id}: ${e.message}`)
      }
    }

    return {
      success: true,
      dryRun: false,
      scanned: albums.length,
      duplicateGroups: groups.length,
      removed,
      reviewsMoved,
      favoritesMoved,
      errors,
      samples: groups.slice(0, 10).map(toSummary),
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

async function checkAdmin(openId) {
  if (!openId) return false
  const r = await db.collection('users')
    .where({ openId, type: 'admin' })
    .limit(1)
    .get()
  return r.data.length > 0
}

async function fetchAllAlbums() {
  const albums = []
  let skip = 0
  while (true) {
    const r = await db.collection('albums')
      .field({
        _id: true,
        title: true,
        artist: true,
        primaryArtist: true,
        releaseDate: true,
        releaseYear: true,
        coverUrl: true,
        sourceId: true,
        source: true,
        approved: true,
        avgScore: true,
        reviewCount: true,
        trackCount: true,
        neteaseArtistId: true,
        artistIds: true,
        ownerArtistIds: true,
      })
      .skip(skip)
      .limit(PAGE_SIZE)
      .get()
    albums.push(...r.data)
    if (r.data.length < PAGE_SIZE) break
    skip += r.data.length
  }
  return albums
}

function buildDuplicateGroups(albums) {
  const groups = []
  const assigned = new Set()

  // Tier 1: exact upstream identity. sourceId identifies the album itself, not the artist page
  // it was discovered from, so duplicates must be grouped globally across artists.
  const sourceBuckets = new Map()
  albums.forEach(album => {
    const sourceId = String(album.sourceId || '').trim()
    if (!sourceId) return
    const key = `sourceId:${sourceId}`
    if (!sourceBuckets.has(key)) sourceBuckets.set(key, [])
    sourceBuckets.get(key).push(album)
  })
  sourceBuckets.forEach((items, key) => {
    if (items.length < 2) return
    const sorted = items.slice().sort(preferKeep)
    groups.push({ key, matchType: 'sourceId', keep: sorted[0], remove: sorted.slice(1) })
    items.forEach(a => assigned.add(a._id))
  })

  // Tier 2: strict semantic identity for historical rows that were imported under different
  // sourceIds. Requiring title + release date/year + track count keeps this conservative.
  const semanticBuckets = new Map()
  albums.forEach(album => {
    if (assigned.has(album._id)) return
    const key = semanticDuplicateKey(album)
    if (!key) return
    if (!semanticBuckets.has(key)) semanticBuckets.set(key, [])
    semanticBuckets.get(key).push(album)
  })
  semanticBuckets.forEach((items, key) => {
    if (items.length < 2) return
    const sorted = items.slice().sort(preferKeep)
    groups.push({ key, matchType: 'semantic', keep: sorted[0], remove: sorted.slice(1) })
  })

  return groups
}

function semanticDuplicateKey(album) {
  const title = normalizeTitle(album.title || '')
  const release = normalizeRelease(album)
  const trackCount = Number(album.trackCount || 0)
  if (!title || !release || !trackCount) return ''
  return `semantic:${title}|${release}|tracks:${trackCount}`
}

function normalizeRelease(album) {
  const date = String(album.releaseDate || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  const year = Number(album.releaseYear || 0)
  return year ? String(year) : ''
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[《》「」『』【】\[\]()（）.,，。:：;；!！?？'"“”‘’_-]/g, '')
}

function preferKeep(a, b) {
  const av = keepScore(a)
  const bv = keepScore(b)
  if (bv !== av) return bv - av
  return String(a._id).localeCompare(String(b._id))
}

function keepScore(album) {
  let score = 0
  if (album.approved) score += 100000
  score += (album.reviewCount || 0) * 1000
  score += Math.round((album.avgScore || 0) * 100)
  if (album.coverUrl) score += 10
  if (album.trackCount) score += Math.min(album.trackCount, 99)
  return score
}

async function recalcAlbumScore(albumId) {
  const reviews = []
  let skip = 0
  while (true) {
    const r = await db.collection('reviews')
      .where({ albumId })
      .field({ rating: true })
      .skip(skip)
      .limit(PAGE_SIZE)
      .get()
    reviews.push(...r.data)
    if (r.data.length < PAGE_SIZE) break
    skip += r.data.length
  }

  const count = reviews.length
  const sum = reviews.reduce((acc, r) => acc + (Number(r.rating) || 0), 0)
  const avgScore = count ? Math.round((sum / count) * 10) / 10 : 0
  await db.collection('albums').doc(albumId).update({ data: { reviewCount: count, avgScore } })
}

function toSummary(group) {
  return {
    key: group.key,
    matchType: group.matchType,
    keep: {
      _id: group.keep._id,
      title: group.keep.title,
      artist: group.keep.artist,
      approved: !!group.keep.approved,
      reviewCount: group.keep.reviewCount || 0,
    },
    remove: group.remove.map(a => ({
      _id: a._id,
      title: a.title,
      artist: a.artist,
      approved: !!a.approved,
      reviewCount: a.reviewCount || 0,
    })),
  }
}
