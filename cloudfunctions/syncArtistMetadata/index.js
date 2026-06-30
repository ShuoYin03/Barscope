const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _  = db.command

const PAGE_SIZE = 100
const WRITE_BATCH = 20

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const limit = Number(event.limit || 0)
  const force = !!event.force

  try {
    if (!(await checkAdmin(OPENID))) {
      return { success: false, error: 'unauthorized' }
    }

    const candidates = await fetchApprovedCandidates(limit)
    let updated = 0
    let skipped = 0
    let errors = 0
    const samples = []

    for (let i = 0; i < candidates.length; i += WRITE_BATCH) {
      const batch = candidates.slice(i, i + WRITE_BATCH)
      const results = await Promise.allSettled(batch.map(candidate => syncOneArtist(candidate, force)))
      results.forEach((r) => {
        if (r.status === 'fulfilled') {
          if (r.value.updated) {
            updated += 1
            if (samples.length < 10) samples.push(r.value.sample)
          } else {
            skipped += 1
          }
        } else {
          errors += 1
        }
      })
      if (i + WRITE_BATCH < candidates.length) {
        await sleep(300)
      }
    }

    return {
      success: true,
      scanned: candidates.length,
      updated,
      skipped,
      errors,
      samples,
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

async function checkAdmin(openId) {
  if (!openId) return false
  try {
    const r = await db.collection('users')
      .where({ openId, type: 'admin' })
      .limit(1)
      .get()
    return r.data.length > 0
  } catch {
    return false
  }
}

async function fetchApprovedCandidates(limit) {
  const list = []
  let skip = 0
  while (true) {
    const pageLimit = limit ? Math.min(PAGE_SIZE, limit - list.length) : PAGE_SIZE
    if (pageLimit <= 0) break

    const r = await db.collection('artist_candidates')
      .where({ status: 'approved' })
      .field({
        _id: true,
        artistId: true,
        artistName: true,
        picUrl: true,
        avatarUrl: true,
        coverUrl: true,
        backgroundUrl: true,
        heroImageUrl: true,
        fansSize: true,
        albumSize: true,
        musicSize: true,
      })
      .skip(skip)
      .limit(pageLimit)
      .get()

    list.push(...r.data.filter(a => a.artistId))
    if (r.data.length < pageLimit) break
    skip += r.data.length
    if (limit && list.length >= limit) break
  }
  return list
}

async function syncOneArtist(candidate, force) {
  const artistId = Number(candidate.artistId)
  if (!artistId) return { updated: false }

  if (!force && candidate.picUrl && candidate.heroImageUrl) {
    return { updated: false }
  }

  const detail = await fetchArtistDetail(artistId)
  if (!detail) return { updated: false }

  const artist = normalizeArtistPayload(detail)
  const profile = detail.profile || detail.data?.profile || {}

  const patch = buildPatch(candidate, artist, profile)
  if (!patch.avatarUrl && !patch.heroImageUrl && !patch.artistName) {
    return { updated: false }
  }

  await db.collection('artist_candidates').doc(candidate._id).update({ data: patch })
  await upsertArtistProfile(artistId, patch)

  return {
    updated: true,
    sample: {
      artistId,
      artistName: patch.artistName || candidate.artistName,
      avatarUrl: patch.avatarUrl || '',
      heroImageUrl: patch.heroImageUrl || '',
    },
  }
}

function normalizeArtistPayload(detail) {
  if (detail.artist) return detail.artist
  if (detail.data && detail.data.artist) return detail.data.artist
  if (detail.data && detail.data.user) return detail.data.user
  return detail.data || detail
}

function buildPatch(candidate, artist, profile) {
  const name = artist.name || profile.nickname || candidate.artistName || ''
  const avatarUrl = firstNonEmpty([
    artist.picUrl,
    artist.img1v1Url,
    artist.avatarUrl,
    profile.avatarUrl,
    candidate.avatarUrl,
    candidate.picUrl,
  ])
  const heroImageUrl = firstNonEmpty([
    artist.cover,
    artist.coverUrl,
    artist.backgroundUrl,
    profile.backgroundUrl,
    candidate.heroImageUrl,
    candidate.backgroundUrl,
    candidate.coverUrl,
    avatarUrl,
  ])
  const alias = Array.isArray(artist.alias) ? artist.alias : []

  return {
    artistName: name,
    picUrl: avatarUrl,
    avatarUrl,
    coverUrl: heroImageUrl,
    backgroundUrl: heroImageUrl,
    heroImageUrl,
    fansSize: Number(artist.followedCount || artist.fansCount || artist.fansSize || candidate.fansSize || 0),
    albumSize: Number(artist.albumSize || candidate.albumSize || 0),
    musicSize: Number(artist.musicSize || candidate.musicSize || 0),
    alias,
    briefDesc: artist.briefDesc || artist.trans || profile.signature || '',
    syncedAt: db.serverDate(),
  }
}

async function upsertArtistProfile(artistId, patch) {
  const data = {
    neteaseArtistId: String(artistId),
    artistId,
    name: patch.artistName,
    artistName: patch.artistName,
    picUrl: patch.picUrl,
    avatarUrl: patch.avatarUrl,
    coverUrl: patch.coverUrl,
    backgroundUrl: patch.backgroundUrl,
    heroImageUrl: patch.heroImageUrl,
    fansSize: patch.fansSize,
    albumSize: patch.albumSize,
    musicSize: patch.musicSize,
    alias: patch.alias,
    briefDesc: patch.briefDesc,
    syncedAt: db.serverDate(),
  }

  const existing = await db.collection('artists')
    .where({ neteaseArtistId: String(artistId) })
    .limit(1)
    .get()

  if (existing.data.length > 0) {
    await db.collection('artists').doc(existing.data[0]._id).update({ data })
  } else {
    await db.collection('artists').add({ data })
  }
}

function fetchArtistDetail(artistId) {
  const urls = [
    `https://music.163.com/api/artist/head/info/get?id=${artistId}`,
    `https://music.163.com/api/v1/artist/${artistId}`,
    `https://music.163.com/api/artist/${artistId}`,
  ]

  return urls.reduce((promise, url) => {
    return promise.then(result => result || httpsGetJson(url).catch(() => null))
  }, Promise.resolve(null))
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com/',
        'Accept': 'application/json,text/plain,*/*',
      },
    }, res => {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', () => {
        try {
          const json = JSON.parse(buf)
          resolve(json)
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(12000, () => {
      req.destroy()
      reject(new Error('timeout'))
    })
  })
}

function firstNonEmpty(values) {
  return values.find(v => String(v || '').trim()) || ''
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
