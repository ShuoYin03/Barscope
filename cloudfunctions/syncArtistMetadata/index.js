const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _  = db.command

const WRITE_BATCH = 20

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const limit = Number(event.limit || 100)
  const skip  = Number(event.skip  || 0)

  try {
    if (!(await checkAdmin(OPENID))) {
      return { success: false, error: 'unauthorized' }
    }

    const { candidates, total } = await fetchApprovedCandidates(skip, limit)
    let updated = 0
    let skipped = 0
    let errors  = 0
    const samples      = []
    const errorSamples = []

    for (let i = 0; i < candidates.length; i += WRITE_BATCH) {
      const batch   = candidates.slice(i, i + WRITE_BATCH)
      const results = await Promise.allSettled(batch.map(syncOneArtist))
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          if (r.value.updated) {
            updated += 1
            if (samples.length < 10) samples.push(r.value.sample)
          } else {
            skipped += 1
          }
        } else {
          errors += 1
          if (errorSamples.length < 3) {
            const c = batch[idx]
            console.error(`[sync] error artistId=${c && c.artistId}`, r.reason && r.reason.message)
            errorSamples.push({ artistId: c && c.artistId, err: r.reason && r.reason.message })
          }
        }
      })
      if (i + WRITE_BATCH < candidates.length) {
        await sleep(200)
      }
    }

    const nextSkip = skip + candidates.length
    const hasMore  = nextSkip < total

    return {
      success: true,
      scanned:  candidates.length,
      updated,
      skipped,
      errors,
      total,
      nextSkip,
      hasMore,
      samples,
      errorSamples,
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

async function fetchApprovedCandidates(skip, limit) {
  // get total count first
  const countRes = await db.collection('artist_candidates')
    .where({ status: 'approved' })
    .count()
  const total = countRes.total

  const r = await db.collection('artist_candidates')
    .where({ status: 'approved' })
    .field({
      _id: true,
      artistId: true,
      artistName: true,
      picUrl: true,
      coverUrl: true,
      backgroundUrl: true,
      fansSize: true,
      albumSize: true,
      musicSize: true,
    })
    .skip(skip)
    .limit(limit)
    .get()

  return { candidates: r.data.filter(a => a.artistId), total }
}

async function syncOneArtist(candidate) {
  const artistId = Number(candidate.artistId)
  if (!artistId) return { updated: false }

  const detail = await fetchArtistDetail(artistId)
  if (!detail) return { updated: false }

  const artist  = detail.artist || (detail.data && detail.data.artist) || detail
  const profile = detail.profile || (detail.data && detail.data.profile) || {}

  const patch = buildPatch(candidate, artist, profile)
  if (!patch.picUrl && !patch.backgroundUrl && !patch.artistName) {
    return { updated: false }
  }

  await db.collection('artist_candidates').doc(candidate._id).update({ data: patch })
  await upsertArtistProfile(artistId, patch)

  return {
    updated: true,
    sample: {
      artistId,
      artistName: patch.artistName || candidate.artistName,
      picUrl: patch.picUrl || '',
    },
  }
}

function buildPatch(candidate, artist, profile) {
  const name          = artist.name        || profile.nickname  || candidate.artistName || ''
  const picUrl        = artist.picUrl      || artist.img1v1Url  || artist.avatarUrl     || profile.avatarUrl    || candidate.picUrl        || ''
  const backgroundUrl = artist.cover       || artist.coverUrl   || artist.picUrl        || profile.backgroundUrl || candidate.backgroundUrl || candidate.coverUrl || picUrl || ''
  const alias         = Array.isArray(artist.alias) ? artist.alias : []

  return {
    artistName:  name,
    picUrl,
    avatarUrl:   picUrl,
    coverUrl:    backgroundUrl,
    backgroundUrl,
    fansSize:    Number(artist.followedCount || artist.fansCount  || artist.fansSize  || candidate.fansSize  || 0),
    albumSize:   Number(artist.albumSize     || candidate.albumSize || 0),
    musicSize:   Number(artist.musicSize     || candidate.musicSize || 0),
    alias,
    briefDesc:   artist.briefDesc || artist.trans || profile.signature || '',
    syncedAt:    db.serverDate(),
  }
}

async function upsertArtistProfile(artistId, patch) {
  const data = {
    neteaseArtistId: String(artistId),
    artistId,
    name:            patch.artistName,
    artistName:      patch.artistName,
    picUrl:          patch.picUrl,
    avatarUrl:       patch.avatarUrl,
    coverUrl:        patch.coverUrl,
    backgroundUrl:   patch.backgroundUrl,
    fansSize:        patch.fansSize,
    albumSize:       patch.albumSize,
    musicSize:       patch.musicSize,
    alias:           patch.alias,
    briefDesc:       patch.briefDesc,
    syncedAt:        db.serverDate(),
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
    `https://music.163.com/api/artist/${artistId}`,
  ]

  return urls.reduce((promise, url) => {
    return promise.then(function(result) {
      return result || httpsGetJson(url).catch(function() { return null })
    })
  }, Promise.resolve(null))
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    'https://music.163.com/',
        'Accept':     'application/json,text/plain,*/*',
      },
    }, res => {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', () => {
        try   { resolve(JSON.parse(buf)) }
        catch (e) { reject(e) }
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
