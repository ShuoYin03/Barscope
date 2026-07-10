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
    const artistIds = Array.from(new Set(clean.map(x=>x.artistId)))
    const artistNames = clean.filter((x,i,a)=>a.findIndex(y=>y.artistId===x.artistId)===i).map(x=>x.artistName)
    await db.collection('albums').doc(albumId).update({ data:{
      artist:artistNames.join(' / '),
      primaryArtist:artistNames[0],
      neteaseArtistId:artistIds[0],
      artistIds,
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
function isCollectionMissing(e) { const msg = String(e && (e.errMsg || e.message) || ''); return msg.includes('DATABASE_COLLECTION_NOT_EXIST') || msg.includes('collection not exists') || msg.includes('Db or Table not exist') }