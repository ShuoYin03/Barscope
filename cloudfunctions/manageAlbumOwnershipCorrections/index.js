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
  return { success:false, error:'unknown action' }
}
async function isAdmin(openId){ if(!openId)return false; const r=await db.collection('users').where({openId,type:'admin'}).limit(1).get(); return r.data.length>0 }
async function list(status){ try { const r=await db.collection(COL).where({status}).orderBy('submittedAt','desc').limit(100).get(); return {success:true,list:r.data,total:r.data.length} } catch(e) { if(isCollectionMissing(e)) return {success:true,list:[],total:0}; throw e } }
async function stats(){ try { const r=await db.collection(COL).where({status:'pending'}).count(); return {success:true,pending:r.total} } catch(e) { if(isCollectionMissing(e)) return {success:true,pending:0}; throw e } }
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
    const clean = targets.map(x=>({artistId:String(x&&x.artistId||'').trim(),artistName:String(x&&x.artistName||'').trim()})).filter(x=>x.artistId&&x.artistName)
    if(!clean.length) return {success:false,error:'missing target artists'}
    // The admin's selection defines the OWNER set. The participant list (artistIds) — which drives the
    // "+N" tag and Feat classification — must keep every collaborator, so we union owners into the
    // album's existing participants rather than shrinking it to the owners.
    const owners = clean.filter((x,i,a)=>a.findIndex(y=>y.artistId===x.artistId)===i)
    const ownerArtistIds = owners.map(x=>x.artistId)
    const ownerNames = owners.map(x=>x.artistName)
    const albumDoc = (await db.collection('albums').doc(albumId).get()).data || {}
    const existingIds = Array.isArray(albumDoc.artistIds) ? albumDoc.artistIds.map(String) : []
    const addedOwners = owners.filter(o=>!existingIds.includes(o.artistId))
    const artistIds = existingIds.concat(addedOwners.map(o=>o.artistId))
    // Keep artist-string ↔ artistIds index alignment (buildNameById relies on it): append new owner names.
    const artist = existingIds.length
      ? [String(albumDoc.artist||'').trim(), ...addedOwners.map(o=>o.artistName)].filter(Boolean).join(' / ')
      : ownerNames.join(' / ')
    // Reclassify already-synced tracks against the corrected owner set so per-track credits and
    // Featuring Guests reflect the new ownership immediately, instead of waiting on a NetEase re-sync
    // (which only runs when an album's tracks are still empty).
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
  }
  await db.collection(COL).doc(id).update({ data:{
    status:decision === 'approve' ? 'approved' : 'declined',
    decision,
    decidedAt:db.serverDate(),
    decidedBy:openId,
  } })
  return {success:true}
}
function collectGuests(tracks) { const map=new Map(); tracks.forEach(track=>(track.guests||[]).forEach(g=>{const key=g.id?String(g.id):g.name;if(!map.has(key))map.set(key,{id:g.id||0,name:g.name,count:0,trackNos:[]});const x=map.get(key);x.count++;x.trackNos.push(track.no)}));return Array.from(map.values()).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name)) }
function isCollectionMissing(e) { const msg = String(e && (e.errMsg || e.message) || ''); return msg.includes('DATABASE_COLLECTION_NOT_EXIST') || msg.includes('collection not exists') || msg.includes('Db or Table not exist') }