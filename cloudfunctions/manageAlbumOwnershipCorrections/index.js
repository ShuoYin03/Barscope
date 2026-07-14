const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COL = 'album_ownership_corrections'

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'
  if (!(await isAdmin(OPENID))) return { success:false, error:'unauthorized' }
  if (action === 'list') return list(event.status || 'pending')
  if (action === 'stats') return stats()
  if (action === 'decide') return decide(event.id, event.decision, OPENID)
  if (action === 'batchApply') return batchApply(event.albumIds, event.targetArtists, OPENID)
  return { success:false, error:'unknown action' }
}
async function isAdmin(openId){ if(!openId)return false; const r=await db.collection('users').where({openId,type:'admin'}).limit(1).get(); return r.data.length>0 }
async function list(status){ try { const r=await db.collection(COL).where({status}).orderBy('submittedAt','desc').limit(100).get(); return {success:true,list:r.data,total:r.data.length} } catch(e) { if(isCollectionMissing(e)) return {success:true,list:[],total:0}; throw e } }
async function stats(){ try { const r=await db.collection(COL).where({status:'pending'}).count(); return {success:true,pending:r.total} } catch(e) { if(isCollectionMissing(e)) return {success:true,pending:0}; throw e } }

function cleanTargets(targets){
  const clean = (Array.isArray(targets)?targets:[]).map(x=>({artistId:String(x&&x.artistId||'').trim(),artistName:String(x&&x.artistName||'').trim()})).filter(x=>x.artistId&&x.artistName)
  return clean.filter((x,i,a)=>a.findIndex(y=>y.artistId===x.artistId)===i)
}

// The admin's selection defines the OWNER set. The participant list (artistIds) — which drives the
// "+N" tag and Feat classification — must keep every collaborator, so we union owners into the
// album's existing participants rather than shrinking it to the owners. Already-synced tracks are
// reclassified against the corrected owner set so per-track credits and Featuring Guests reflect the
// new ownership immediately, instead of waiting on a NetEase re-sync (which only runs when an album's
// tracks are still empty).
async function applyOwnershipToAlbum(albumId, owners, openId){
  const ownerArtistIds = owners.map(x=>x.artistId)
  const ownerNames = owners.map(x=>x.artistName)
  const albumDoc = (await db.collection('albums').doc(albumId).get()).data || {}
  const existingIds = Array.isArray(albumDoc.artistIds) ? albumDoc.artistIds.map(String) : []
  const addedOwners = owners.filter(o=>!existingIds.includes(o.artistId))
  const artistIds = existingIds.concat(addedOwners.map(o=>o.artistId))
  // The display string (used by home/list pages) must reflect the OWNER set, not "existing string
  // plus newly-added participants" — a participant who was already tracked (e.g. a featured guest
  // from the original NetEase sync) can still be newly *promoted* to owner without being "added".
  const artist = ownerNames.join(' / ')
  const ownerIdSet = new Set(ownerArtistIds)
  const ownerNameSet = new Set(ownerNames)
  const tracks = (Array.isArray(albumDoc.tracks) ? albumDoc.tracks : []).map(t => {
    const trackArtists = Array.isArray(t.artists) ? t.artists : []
    const guests = trackArtists.filter(a => !ownerIdSet.has(String(a && a.id || '')) && !ownerNameSet.has(String(a && a.name || '').trim()))
    return { ...t, guests, hasFeaturing:guests.length>0 }
  })
  const featuringGuests = collectGuests(tracks)
  await db.collection('albums').doc(albumId).update({ data:{
    artist,
    primaryArtist:ownerNames[0],
    neteaseArtistId:ownerArtistIds[0],
    ownerArtistIds,
    ownerArtists:owners.map(o=>({id:Number(o.artistId)||0,name:o.artistName})),
    artistIds,
    isMultiArtist:ownerArtistIds.length>1,
    tracks,
    featuringGuests,
    ownershipCorrectedAt:db.serverDate(),
    ownershipCorrectedBy:openId,
    ownershipSource:'user-admin-correction',
  } })
  return { artist, primaryArtist:ownerNames[0] }
}

async function decide(id, decision, openId){
  if(!id || !['approve','decline'].includes(decision)) return {success:false,error:'invalid decision'}
  const doc = await db.collection(COL).doc(id).get()
  const item = doc.data
  if(!item) return {success:false,error:'correction not found'}
  if(decision === 'approve'){
    const albumId = String(item.albumId || '')
    if(!albumId) return {success:false,error:'missing albumId'}
    const targets = Array.isArray(item.targetArtists) && item.targetArtists.length
      ? item.targetArtists
      : [{artistId:item.targetArtistId,artistName:item.targetArtistName}]
    const owners = cleanTargets(targets)
    if(!owners.length) return {success:false,error:'missing target artists'}
    await applyOwnershipToAlbum(albumId, owners, openId)
  }
  await db.collection(COL).doc(id).update({ data:{
    status:decision === 'approve' ? 'approved' : 'declined',
    decision,
    decidedAt:db.serverDate(),
    decidedBy:openId,
  } })
  return {success:true}
}

// Admin-driven bulk correction: apply the same owner set to many albums at once, bypassing the
// pending-review queue since the admin is already the approver.
async function batchApply(albumIds, targetArtists, openId){
  const owners = cleanTargets(targetArtists)
  if(!owners.length) return {success:false,error:'missing target artists'}
  const ids = (Array.isArray(albumIds)?albumIds:[]).map(String).filter(Boolean)
  if(!ids.length) return {success:false,error:'missing albumIds'}
  let succeeded=0
  const failed=[]
  for(const albumId of ids){
    try{ await applyOwnershipToAlbum(albumId, owners, openId); succeeded++ }
    catch(e){ failed.push({albumId,error:e.message}) }
  }
  return { success:true, succeeded, failed, artist:owners.map(o=>o.artistName).join(' / ') }
}

function collectGuests(tracks) { const map=new Map(); tracks.forEach(track=>(track.guests||[]).forEach(g=>{const key=g.id?String(g.id):g.name;if(!map.has(key))map.set(key,{id:g.id||0,name:g.name,count:0,trackNos:[]});const x=map.get(key);x.count++;x.trackNos.push(track.no)}));return Array.from(map.values()).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name)) }
function isCollectionMissing(e) { const msg = String(e && (e.errMsg || e.message) || ''); return msg.includes('DATABASE_COLLECTION_NOT_EXIST') || msg.includes('collection not exists') || msg.includes('Db or Table not exist') }
