const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const PAGE_SIZE = 20

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { resolve(null) } })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')) })
  })
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

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!(await isAdmin(OPENID))) return { success: false, error: '无权限' }

  const skip = Math.max(0, Number(event.skip || 0))
  const res = await db.collection('albums').field({ _id: true, sourceId: true, releaseDate: true, releaseYear: true }).skip(skip).limit(PAGE_SIZE).get()
  const rows = res.data || []
  let updated = 0
  let missingSourceId = 0
  let failed = 0

  for (const album of rows) {
    if (album.releaseDate) continue
    const sourceId = String(album.sourceId || '')
    if (!/^\d+$/.test(sourceId)) { missingSourceId += 1; continue }
    try {
      const data = await httpsGet(`https://music.163.com/api/v1/album/${sourceId}`)
      const raw = data && data.code === 200 ? data.album : null
      const releaseDate = raw ? formatDate(raw.publishTime) : ''
      if (!releaseDate) { failed += 1; continue }
      await db.collection('albums').doc(album._id).update({ data: { releaseDate, releaseYear: Number(releaseDate.slice(0, 4)) } })
      updated += 1
    } catch (e) { failed += 1 }
  }

  const nextSkip = rows.length === PAGE_SIZE ? skip + PAGE_SIZE : null
  return { success: true, processed: rows.length, updated, failed, missingSourceId, nextSkip, done: nextSkip === null }
}
