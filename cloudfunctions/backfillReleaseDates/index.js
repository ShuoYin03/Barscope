const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const PAGE_SIZE = 60
const CONCURRENCY = 6

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { resolve(null) } })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function fetchAlbumWithRetry(sourceId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const data = await httpsGet(`https://music.163.com/api/v1/album/${sourceId}`)
      const raw = data && data.code === 200 ? data.album : null
      if (raw) return raw
    } catch (e) {}
    if (attempt < 2) await sleep(250 * (attempt + 1))
  }
  return null
}

function formatDate(publishTime) {
  const stamp = Number(publishTime)
  if (!stamp) return ''
  const d = new Date(stamp)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function isAdmin(openId) {
  if (!openId) return false
  const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
  return r.data.length > 0
}

async function runPool(items, worker) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await worker(items[index])
    }
  })
  await Promise.all(workers)
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!(await isAdmin(OPENID))) return { success: false, error: '无权限' }

  const skip = Math.max(0, Number(event.skip || 0))
  const res = await db.collection('albums')
    .field({ _id: true, sourceId: true, albumId: true, neteaseAlbumId: true, releaseDate: true, releaseYear: true })
    .skip(skip)
    .limit(PAGE_SIZE)
    .get()
  const rows = res.data || []
  let updated = 0
  let missingSourceId = 0
  let failed = 0
  let alreadyHadDate = 0

  await runPool(rows, async (album) => {
    if (album.releaseDate) { alreadyHadDate += 1; return }
    const sourceId = String(album.sourceId || album.neteaseAlbumId || album.albumId || '')
    if (!/^\d+$/.test(sourceId)) { missingSourceId += 1; return }
    const raw = await fetchAlbumWithRetry(sourceId)
    const releaseDate = raw ? formatDate(raw.publishTime) : ''
    if (!releaseDate) { failed += 1; return }
    try {
      await db.collection('albums').doc(album._id).update({ data: { releaseDate, releaseYear: Number(releaseDate.slice(0, 4)) } })
      updated += 1
    } catch (e) { failed += 1 }
  })

  const nextSkip = rows.length === PAGE_SIZE ? skip + PAGE_SIZE : null
  return { success: true, processed: rows.length, updated, failed, missingSourceId, alreadyHadDate, nextSkip, done: nextSkip === null }
}
