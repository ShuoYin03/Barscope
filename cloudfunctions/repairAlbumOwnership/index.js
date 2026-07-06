const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const PAGE_SIZE = 24
const CONCURRENCY = 8
const INTERNAL_TOKEN = 'repair_album_ownership_v1'

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  const internal = event.__internal === true && event.__token === INTERNAL_TOKEN
  if (!internal && !(await isAdmin(OPENID))) return { success:false, error:'无权限' }

  const cursor = Math.max(0, Number(event.cursor || 0))
  const dryRun = event.dryRun === true
  const count = await db.collection('albums').where({ approved:true }).count()
  const total = Number(count.total || 0)
  if (!total) return { success:true, done:true, total:0, checked:0, corrected:0 }

  const res = await db.collection('albums')
    .where({ approved:true })
    .field({ _id:true, sourceId:true, title:true, artist:true, primaryArtist:true, neteaseArtistId:true, collaboratorArtists:true, collaboratorArtistIds:true, collaboratorArtistNames:true })
    .skip(cursor)
    .limit(PAGE_SIZE)
    .get()
  const rows = (res.data || []).filter(x => x.sourceId)
  const results = await mapWithConcurrency(rows, CONCURRENCY, repairOne)
  const corrected = results.filter(x => x.corrected).length
  const failed = results.filter(x => x.failed).length
  const next = cursor + rows.length

  if (next < total && rows.length) {
    await cloud.callFunction({ name:'repairAlbumOwnership', data:{ cursor:next, dryRun, __internal:true, __token:INTERNAL_TOKEN } })
  }

  return {
    success:true,
    done: next >= total || !rows.length,
    total,
    cursor,
    next: Math.min(next, total),
    checked: rows.length,
    corrected,
    failed,
    sample: results.slice(0, 5),
  }

  async function repairOne(doc) {
    try {
      const detail = await fetchAlbumDetail(String(doc.sourceId))
      const raw = detail && detail.album
      if (!raw) return { id:doc._id, title:doc.title, corrected:false, failed:true, reason:'网易云详情缺失' }
      // Sole authority for album ownership: detail album-level artist line.
      const official = Array.isArray(raw.artists) && raw.artists.length ? raw.artists : (raw.artist ? [raw.artist] : [])
      const collaborators = official.map(a => ({ id:String(a && a.id || ''), name:String(a && a.name || '').trim() })).filter(a => a.id || a.name)
      const ids = [...new Set(collaborators.map(a => a.id).filter(Boolean))]
      const names = [...new Set(collaborators.map(a => a.name).filter(Boolean))]
      const primaryArtist = String((raw.artist || {}).name || names[0] || doc.primaryArtist || '').trim()
      const primaryId = String((raw.artist || {}).id || ids[0] || doc.neteaseArtistId || '')
      if (!primaryArtist) return { id:doc._id, title:doc.title, corrected:false, failed:true, reason:'无主艺人' }
      if (primaryId && !ids.includes(primaryId)) ids.unshift(primaryId)
      if (primaryArtist && !names.includes(primaryArtist)) names.unshift(primaryArtist)
      const artist = names.join(' / ')
      const changed = doc.artist !== artist || doc.primaryArtist !== primaryArtist || String(doc.neteaseArtistId || '') !== primaryId || !same(doc.collaboratorArtistIds, ids) || !same(doc.collaboratorArtistNames, names) || !sameArtists(doc.collaboratorArtists, collaborators)
      if (changed && !dryRun) {
        await db.collection('albums').doc(doc._id).update({ data:{ artist, primaryArtist, neteaseArtistId:primaryId, collaboratorArtists:collaborators, collaboratorArtistIds:ids, collaboratorArtistNames:names, ownershipCorrectedAt:db.serverDate(), ownershipSource:'netease-album-detail' } })
      }
      return { id:doc._id, title:doc.title, corrected:changed, owners:names }
    } catch (e) {
      return { id:doc._id, title:doc.title, corrected:false, failed:true, reason:e.message }
    }
  }
}

async function isAdmin(openId) {
  if (!openId) return false
  const r = await db.collection('users').where({ openId, type:'admin' }).limit(1).get()
  return r.data.length > 0
}
function mapWithConcurrency(items, limit, fn) {
  let index = 0
  return Promise.all(Array.from({ length:Math.min(limit, items.length) }, async () => {
    const out = []
    while (true) {
      const i = index++
      if (i >= items.length) return out
      out.push(await fn(items[i]))
    }
  })).then(groups => groups.flat())
}
function same(a,b){ return JSON.stringify(Array.isArray(a)?a:[]) === JSON.stringify(Array.isArray(b)?b:[]) }
function sameArtists(a,b){ const norm=x=>(Array.isArray(x)?x:[]).map(v=>({id:String(v.id||''),name:String(v.name||'')})); return JSON.stringify(norm(a))===JSON.stringify(norm(b)) }
async function fetchAlbumDetail(albumId) {
  const data = await httpsGet(`https://music.163.com/api/v1/album/${albumId}`)
  return data && data.code === 200 ? data : null
}
function httpsGet(url) {
  return new Promise((resolve,reject) => {
    const req = https.get(url, { headers:{ 'User-Agent':'Mozilla/5.0', Referer:'https://music.163.com/' } }, res => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { resolve(null) } })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}
