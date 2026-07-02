const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const WRITE_BATCH = 8
const MOBILE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 NeteaseMusic/9.0.0',
  'Referer': 'https://y.music.163.com/',
  'Accept': 'text/html,application/json,text/plain,*/*',
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const skip = Number(event.skip || 0)
  const limit = Number(event.limit || 100)
  const force = event.force !== false

  try {
    if (!(await checkAdmin(OPENID))) return { success: false, error: 'unauthorized' }

    const { candidates, total } = await fetchApprovedCandidates(skip, limit)
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
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

async function checkAdmin(openId) {
  if (!openId) return false
  try {
    const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
    return r.data.length > 0
  } catch {
    return false
  }
}

// skip/limit 是给小程序端做链式分批调用用的：每次只处理一页，靠 hasMore/nextSkip
// 让客户端决定要不要接着调下一批，避免单次云函数调用因为处理艺人太多而超时。
async function fetchApprovedCandidates(skip, limit) {
  const countRes = await db.collection('artist_candidates').where({ status: 'approved' }).count()
  const result = await db.collection('artist_candidates')
    .where({ status: 'approved' })
    .field({ _id: true, artistId: true, artistName: true, avatarUrl: true, heroImageUrl: true })
    .skip(skip)
    .limit(limit)
    .get()
  return { candidates: result.data.filter(item => item.artistId), total: countRes.total }
}

async function syncOneArtist(candidate, force) {
  const artistId = Number(candidate.artistId)
  if (!artistId) return { updated: false }

  if (!force && candidate.avatarUrl && candidate.heroImageUrl) {
    return { updated: false }
  }

  const detail = await fetchMobileArtistDetail(artistId)
  if (!detail) return { updated: false }

  const patch = buildPatch(detail)
  if (!patch.avatarUrl && !patch.heroImageUrl && !patch.artistName) return { updated: false }

  await db.collection('artist_candidates').doc(candidate._id).update({ data: patch })
  await upsertArtistProfile(artistId, patch)

  return {
    updated: true,
    sample: {
      artistId,
      artistName: patch.artistName,
      avatarUrl: patch.avatarUrl,
      heroImageUrl: patch.heroImageUrl,
    },
  }
}

// 只解析移动端网页实际返回的字段，不做任何跨接口/跨字段名的兜底猜测。
function buildPatch(detail) {
  const avatarUrl = detail.avatar || ''
  const heroImageUrl = detail.cover || ''
  return {
    artistName: detail.name || '',
    picUrl: avatarUrl,
    avatarUrl,
    coverUrl: heroImageUrl,
    backgroundUrl: heroImageUrl,
    heroImageUrl,
    albumSize: Number(detail.albumSize || 0),
    musicSize: Number(detail.musicSize || 0),
    alias: Array.isArray(detail.alias) ? detail.alias : [],
    briefDesc: detail.briefDesc || '',
    imageSource: 'mobile-artist-page',
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
    albumSize: patch.albumSize,
    musicSize: patch.musicSize,
    alias: patch.alias,
    briefDesc: patch.briefDesc,
    imageSource: patch.imageSource,
    syncedAt: db.serverDate(),
  }
  const existing = await db.collection('artists').where({ neteaseArtistId: String(artistId) }).limit(1).get()
  if (existing.data.length > 0) await db.collection('artists').doc(existing.data[0]._id).update({ data })
  else await db.collection('artists').add({ data })
}

// 唯一的数据源：网易云音乐移动端艺人页。该页面服务端渲染时会把接口数据内嵌在
// window.REDUX_STATE = {...} 里，直接解析这段 JSON，不再额外请求其它接口兜底。
async function fetchMobileArtistDetail(artistId) {
  const html = await httpsGetText(`https://y.music.163.com/m/artist?id=${artistId}`).catch(() => '')
  if (!html) return null
  const state = extractReduxState(html)
  return (state && state.Artist && state.Artist.data && state.Artist.data.artist) || null
}

function extractReduxState(html) {
  const marker = 'window.REDUX_STATE = '
  const start = html.indexOf(marker)
  if (start < 0) return null

  const jsonStart = start + marker.length
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = jsonStart; i < html.length; i++) {
    const ch = html[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(html.slice(jsonStart, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: MOBILE_HEADERS }, res => {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', () => resolve(buf))
    })
    req.on('error', reject)
    req.setTimeout(12000, () => {
      req.destroy()
      reject(new Error('timeout'))
    })
  })
}
