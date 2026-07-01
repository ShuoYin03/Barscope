const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const WRITE_BATCH = 20

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const limit = Number(event.limit || 100)
  const skip = Number(event.skip || 0)

  try {
    if (!(await checkAdmin(OPENID))) return { success: false, error: 'unauthorized' }

    const { candidates, total } = await fetchApprovedCandidates(skip, limit)
    let updated = 0
    let skipped = 0
    let errors = 0
    const samples = []
    const errorSamples = []

    for (let i = 0; i < candidates.length; i += WRITE_BATCH) {
      const batch = candidates.slice(i, i + WRITE_BATCH)
      const results = await Promise.allSettled(batch.map(syncOneArtist))
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          if (result.value.updated) {
            updated += 1
            if (samples.length < 10) samples.push(result.value.sample)
          } else {
            skipped += 1
          }
        } else {
          errors += 1
          if (errorSamples.length < 3) {
            const candidate = batch[index]
            errorSamples.push({ artistId: candidate && candidate.artistId, err: result.reason && result.reason.message })
          }
        }
      })
      if (i + WRITE_BATCH < candidates.length) await sleep(200)
    }

    const nextSkip = skip + candidates.length
    return {
      success: true,
      scanned: candidates.length,
      updated,
      skipped,
      errors,
      total,
      nextSkip,
      hasMore: nextSkip < total,
      samples,
      errorSamples,
    }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

async function checkAdmin(openId) {
  if (!openId) return false
  try {
    const result = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
    return result.data.length > 0
  } catch {
    return false
  }
}

async function fetchApprovedCandidates(skip, limit) {
  const countRes = await db.collection('artist_candidates').where({ status: 'approved' }).count()
  const result = await db.collection('artist_candidates')
    .where({ status: 'approved' })
    .field({ _id: true, artistId: true, artistName: true, picUrl: true, coverUrl: true, backgroundUrl: true, fansSize: true, albumSize: true, musicSize: true })
    .skip(skip)
    .limit(limit)
    .get()
  return { candidates: result.data.filter(item => item.artistId), total: countRes.total }
}

async function syncOneArtist(candidate) {
  const artistId = Number(candidate.artistId)
  if (!artistId) return { updated: false }

  const detail = await fetchArtistDetail(artistId)
  if (!detail) return { updated: false }

  const patch = buildPatch(candidate, detail)
  if (!patch.picUrl && !patch.backgroundUrl && !patch.artistName) return { updated: false }

  await db.collection('artist_candidates').doc(candidate._id).update({ data: patch })
  await upsertArtistProfile(artistId, patch)

  return {
    updated: true,
    sample: {
      artistId,
      artistName: patch.artistName || candidate.artistName,
      picUrl: patch.picUrl || '',
      backgroundUrl: patch.backgroundUrl || '',
    },
  }
}

function buildPatch(candidate, detail) {
  const artist = detail.artist || {}
  const profile = detail.profile || {}
  const head = detail.head || {}

  // Keep avatar and backdrop independent. The old implementation stopped after the
  // lightweight head endpoint, which often lacks the mobile profile's cover image.
  const picUrl = firstUrl(
    profile.avatarUrl,
    artist.picUrl,
    artist.img1v1Url,
    artist.avatarUrl,
    head.picUrl,
    candidate.picUrl
  )
  const backgroundUrl = firstUrl(
    profile.backgroundUrl,
    artist.cover,
    artist.coverUrl,
    head.cover,
    candidate.backgroundUrl,
    candidate.coverUrl,
    picUrl
  )

  return {
    artistName: artist.name || profile.nickname || head.name || candidate.artistName || '',
    picUrl,
    avatarUrl: picUrl,
    coverUrl: backgroundUrl,
    backgroundUrl,
    fansSize: Number(artist.followedCount || artist.fansCount || profile.followeds || candidate.fansSize || 0),
    albumSize: Number(artist.albumSize || head.albumSize || candidate.albumSize || 0),
    musicSize: Number(artist.musicSize || head.musicSize || candidate.musicSize || 0),
    alias: Array.isArray(artist.alias) ? artist.alias : [],
    briefDesc: artist.briefDesc || artist.trans || profile.signature || '',
    syncedAt: db.serverDate(),
  }
}

function firstUrl(...values) {
  return values.find(value => typeof value === 'string' && value.trim()) || ''
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
    fansSize: patch.fansSize,
    albumSize: patch.albumSize,
    musicSize: patch.musicSize,
    alias: patch.alias,
    briefDesc: patch.briefDesc,
    syncedAt: db.serverDate(),
  }

  const existing = await db.collection('artists').where({ neteaseArtistId: String(artistId) }).limit(1).get()
  if (existing.data.length > 0) {
    await db.collection('artists').doc(existing.data[0]._id).update({ data })
  } else {
    await db.collection('artists').add({ data })
  }
}

async function fetchArtistDetail(artistId) {
  // Fetch both payloads instead of treating the first non-error response as complete.
  // /api/v1/artist is the source used by the mobile artist page for picUrl and cover.
  const [mobile, head] = await Promise.all([
    httpsGetJson(`https://music.163.com/api/v1/artist/${artistId}`).catch(() => null),
    httpsGetJson(`https://music.163.com/api/artist/head/info/get?id=${artistId}`).catch(() => null),
  ])

  const mobileArtist = mobile && (mobile.artist || (mobile.data && mobile.data.artist)) || {}
  const mobileProfile = mobile && (mobile.profile || (mobile.data && mobile.data.profile)) || {}
  const headArtist = head && (head.artist || (head.data && head.data.artist)) || {}

  if (!Object.keys(mobileArtist).length && !Object.keys(mobileProfile).length && !Object.keys(headArtist).length) return null
  return { artist: { ...headArtist, ...mobileArtist }, profile: mobileProfile, head: headArtist }
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
        'Referer': 'https://music.163.com/',
        'Accept': 'application/json,text/plain,*/*',
      },
    }, res => {
      let buffer = ''
      res.on('data', chunk => { buffer += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`))
        try { resolve(JSON.parse(buffer)) } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => {
      req.destroy()
      reject(new Error('timeout'))
    })
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
