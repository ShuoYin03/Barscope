const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// One invocation repairs exactly one album. Keeping each call tiny prevents CloudBase
// timeouts and lets the mini-program show genuine progress.
exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!(await isAdmin(OPENID))) return { success:false, error:'无权限' }

  const cursor = Math.max(0, Number(event.cursor || 0))
  const totalRes = await db.collection('albums').where({ approved:true }).count()
  const total = Number(totalRes.total || 0)
  if (!total || cursor >= total) return { success:true, done:true, total, next:total, checked:0, corrected:0 }

  const page = await db.collection('albums').where({ approved:true })
    .field({ _id:true, sourceId:true, title:true, artist:true, primaryArtist:true, neteaseArtistId:true, collaboratorArtists:true, collaboratorArtistIds:true, collaboratorArtistNames:true })
    .skip(cursor).limit(1).get()
  const doc = page.data && page.data[0]
  if (!doc) return { success:true, done:true, total, next:total, checked:0, corrected:0 }

  const result = await repairOne(doc)
  const next = cursor + 1
  return { success:true, done:next >= total, total, next, checked:1, corrected:result.corrected ? 1 : 0, failed:result.failed ? 1 : 0, title:doc.title, owners:result.owners || [], reason:result.reason || '' }
}

async function repairOne(doc) {
  try {
    const detail = await fetchAlbumDetail(String(doc.sourceId || ''))
    const raw = detail && detail.album
    if (!raw) return { corrected:false, failed:true, reason:'网易云详情未返回' }

    // Conservative repair: only album-level metadata is considered. Song artists are never used.
    const official = Array.isArray(raw.artists) && raw.artists.length ? raw.artists : (raw.artist ? [raw.artist] : [])
    const collaborators = official.map(a => ({ id:String(a && a.id || ''), name:String(a && a.name || '').trim() })).filter(a => a.id || a.name)
    const ids = [...new Set(collaborators.map(a => a.id).filter(Boolean))]
    const names = [...new Set(collaborators.map(a => a.name).filter(Boolean))]
    const primaryArtist = String((raw.artist || {}).name || names[0] || doc.primaryArtist || '').trim()
    const primaryId = String((raw.artist || {}).id || ids[0] || doc.neteaseArtistId || '')
    if (!primaryArtist) return { corrected:false, failed:true, reason:'无法识别主艺人' }
    if (primaryId && !ids.includes(primaryId)) ids.unshift(primaryId)
    if (primaryArtist && !names.includes(primaryArtist)) names.unshift(primaryArtist)

    const artist = names.join(' / ')
    const changed = doc.artist !== artist || doc.primaryArtist !== primaryArtist || String(doc.neteaseArtistId || '') !== primaryId || !same(doc.collaboratorArtistIds, ids) || !same(doc.collaboratorArtistNames, names) || !sameArtists(doc.collaboratorArtists, collaborators)
    if (changed) {
      await db.collection('albums').doc(doc._id).update({ data:{
        artist,
        primaryArtist,
        neteaseArtistId:primaryId,
        collaboratorArtists:collaborators,
        collaboratorArtistIds:ids,
        collaboratorArtistNames:names,
        ownershipCorrectedAt:db.serverDate(),
        ownershipSource:'netease-album-detail',
      } })
    }
    return { corrected:changed, owners:names }
  } catch (e) {
    return { corrected:false, failed:true, reason:String(e && e.message || '未知错误') }
  }
}

async function isAdmin(openId) {
  if (!openId) return false
  const r = await db.collection('users').where({ openId, type:'admin' }).limit(1).get()
  return r.data.length > 0
}
function same(a,b){ return JSON.stringify(Array.isArray(a)?a:[]) === JSON.stringify(Array.isArray(b)?b:[]) }
function sameArtists(a,b){ const norm=x=>(Array.isArray(x)?x:[]).map(v=>({id:String(v.id||''),name:String(v.name||'')})); return JSON.stringify(norm(a))===JSON.stringify(norm(b)) }
function fetchAlbumDetail(id) { return Promise.race([httpsGet(`https://music.163.com/api/v1/album/${id}`), timeout(4500)]).then(data => data && data.code === 200 ? data : null) }
function timeout(ms) { return new Promise(resolve => setTimeout(() => resolve(null), ms)) }
function httpsGet(url) { return new Promise((resolve,reject) => { const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://music.163.com/'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{resolve(JSON.parse(body))}catch(e){resolve(null)}})});req.on('error',reject);req.setTimeout(4000,()=>{req.destroy();resolve(null)}) }) }
