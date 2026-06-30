const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _  = db.command

const PAGE_SIZE = 100
const WRITE_BATCH = 10

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const limit = Number(event.limit || 0)
  const force = event.force !== false

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
        await sleep(500)
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

  if (!force && isRealImageUrl(candidate.avatarUrl || candidate.picUrl) && isRealImageUrl(candidate.heroImageUrl || candidate.backgroundUrl)) {
    return { updated: false }
  }

  const details = await fetchArtistDetails(artistId)
  if (!details.length) return { updated: false }

  const patch = buildPatch(candidate, details)
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

function buildPatch(candidate, details) {
  const sources = details.map(flattenArtistDetail)
  const name = firstNonEmpty([
    ...sources.map(s => s.name),
    candidate.artistName,
  ])

  // Mobile artist homepage priority:
  // avatarUrl = circular profile photo in mobile card
  // heroImageUrl = large top background image on mobile artist homepage
  const avatarUrl = firstRealImageUrl([
    ...sources.map(s => s.avatarUrl),
    ...sources.map(s => s.img1v1Url),
    ...sources.map(s => s.picUrl),
    candidate.avatarUrl,
    candidate.picUrl,
  ])

  const heroImageUrl = firstRealImageUrl([
    ...sources.map(s => s.backgroundUrl),
    ...sources.map(s => s.coverUrl),
    ...sources.map(s => s.cover),
    ...sources.map(s => s.avatarDetailBgUrl),
    candidate.heroImageUrl,
    candidate.backgroundUrl,
    candidate.coverUrl,
  ])

  const alias = firstArray(sources.map(s => s.alias))
  const fansSize = firstNumber([
    ...sources.map(s => s.followedCount),
    ...sources.map(s => s.fansCount),
    ...sources.map(s => s.fansSize),
    candidate.fansSize,
  ])

  return {
    artistName: name,
    picUrl: avatarUrl,
    avatarUrl,
    coverUrl: heroImageUrl,
    backgroundUrl: heroImageUrl,
    heroImageUrl,
    fansSize,
    albumSize: firstNumber([...sources.map(s => s.albumSize), candidate.albumSize]),
    musicSize: firstNumber([...sources.map(s => s.musicSize), candidate.musicSize]),
    alias,
    briefDesc: firstNonEmpty([...sources.map(s => s.briefDesc), ...sources.map(s => s.signature), ...sources.map(s => s.trans)]),
    syncedAt: db.serverDate(),
  }
}

function flattenArtistDetail(detail) {
  const data = detail.data || {}
  const artist = detail.artist || data.artist || data.artistInfo || {}
  const user = detail.user || data.user || data.userInfo || data.profile || detail.profile || {}
  const profile = detail.profile || data.profile || {}
  const home = data.homePage || data.homepage || detail.homePage || {}
  const card = data.artistCard || data.card || detail.artistCard || {}

  return {
    ...detail,
    ...data,
    ...artist,
    ...user,
    ...profile,
    ...home,
    ...card,
    name: artist.name || data.name || user.nickname || profile.nickname || detail.name,
    avatarUrl: user.avatarUrl || profile.avatarUrl || data.avatarUrl || artist.avatarUrl || artist.picUrl || artist.img1v1Url,
    picUrl: artist.picUrl || data.picUrl || profile.avatarUrl || user.avatarUrl,
    img1v1Url: artist.img1v1Url || data.img1v1Url,
    backgroundUrl: user.backgroundUrl || profile.backgroundUrl || data.backgroundUrl || artist.backgroundUrl || artist.cover || artist.coverUrl,
    coverUrl: artist.coverUrl || data.coverUrl || user.backgroundUrl || profile.backgroundUrl,
    cover: artist.cover || data.cover || user.backgroundUrl || profile.backgroundUrl,
    avatarDetailBgUrl: user.avatarDetail?.identityIconUrl || user.avatarDetailBgUrl || data.avatarDetailBgUrl,
    followedCount: user.followeds || user.followedCount || profile.followeds || artist.followedCount || data.followedCount,
    fansCount: user.fansCount || artist.fansCount || data.fansCount,
    fansSize: user.fansSize || artist.fansSize || data.fansSize,
    albumSize: artist.albumSize || data.albumSize,
    musicSize: artist.musicSize || data.musicSize,
    alias: artist.alias || data.alias,
    briefDesc: artist.briefDesc || data.briefDesc,
    signature: user.signature || profile.signature || data.signature,
    trans: artist.trans || data.trans,
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

async function fetchArtistDetails(artistId) {
  const urls = [
    `https://interface.music.163.com/api/artist/head/info/get?id=${artistId}`,
    `https://music.163.com/api/artist/head/info/get?id=${artistId}`,
    `https://interface.music.163.com/api/v1/artist/${artistId}`,
    `https://music.163.com/api/v1/artist/${artistId}`,
    `https://interface.music.163.com/api/artist/${artistId}`,
    `https://music.163.com/api/artist/${artistId}`,
  ]

  const results = []
  for (const url of urls) {
    const json = await httpsGetJson(url).catch(() => null)
    if (json && Number(json.code || 200) !== 404) results.push(json)
    await sleep(120)
  }
  return results
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 NeteaseMusic/9.0.0',
        'Referer': 'https://y.music.163.com/',
        'Origin': 'https://y.music.163.com',
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

function firstRealImageUrl(values) {
  return values.find(isRealImageUrl) || ''
}

function isRealImageUrl(v) {
  const s = String(v || '').trim()
  if (!s) return false
  if (!/^https?:\/\//.test(s)) return false
  if (/default_avatar|anonymous|1900y1900|109951163563|5639395138885805/.test(s)) return false
  return true
}

function firstNumber(values) {
  const found = values.find(v => Number(v) > 0)
  return Number(found || 0)
}

function firstArray(values) {
  return values.find(v => Array.isArray(v) && v.length) || []
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
