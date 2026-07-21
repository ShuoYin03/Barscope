const cloud=require('wx-server-sdk')
const { isAdmin } = require('./_shared/auth')
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV})
const db=cloud.database()
const COL='artist_profile_corrections'
const ALLOWED_ROLES=new Set(['rapper','producer','label'])

exports.main=async event=>{
  const {OPENID}=cloud.getWXContext()
  const action=String(event.action||'submit')
  if(action==='submit')return submit(event,OPENID)
  if(!(await isAdmin(OPENID)))return {success:false,error:'unauthorized'}
  if(action==='list')return list(event)
  if(action==='approve')return approve(event,OPENID)
  if(action==='reject')return reject(event,OPENID)
  return {success:false,error:'unknown action'}
}

async function ensureCollection(){
  try{await db.collection(COL).limit(1).get()}
  catch(e){
    const msg=String(e&&(e.errMsg||e.message)||'')
    if(!msg.includes('DATABASE_COLLECTION_NOT_EXIST')&&!msg.includes('collection not exists')&&!msg.includes('Db or Table not exist'))throw e
    try{await db.createCollection(COL)}catch(x){}
  }
}
function cleanRoles(values){return Array.from(new Set((Array.isArray(values)?values:[]).map(x=>String(x||'').trim().toLowerCase()).filter(x=>ALLOWED_ROLES.has(x))))}

async function submit(event,openId){
  if(!openId)return {success:false,error:'请先登录'}
  await ensureCollection()
  const artistId=String(event.artistId||'').trim()
  const artistName=String(event.artistName||'').trim().slice(0,80)
  if(!artistId||!artistName)return {success:false,error:'缺少艺人信息'}
  const data={artistId,artistName,roles:cleanRoles(event.roles),avatarUrl:String(event.avatarUrl||'').trim(),heroImageUrl:String(event.heroImageUrl||'').trim(),briefDesc:String(event.briefDesc||'').trim().slice(0,3000)}
  const existing=await db.collection(COL).where({artistId,submitterOpenId:openId,status:'pending'}).limit(1).get()
  if(existing.data.length){await db.collection(COL).doc(existing.data[0]._id).update({data:{...data,updatedAt:db.serverDate()}});return {success:true,updatedExisting:true}}
  const userRes=await db.collection('users').where({openId}).limit(1).get().catch(()=>({data:[]}))
  const user=userRes.data[0]||{}
  const add=await db.collection(COL).add({data:{...data,status:'pending',submitterOpenId:openId,submitterName:user.nickName||'',createdAt:db.serverDate(),updatedAt:db.serverDate()}})
  return {success:true,id:add._id}
}
async function list(event){await ensureCollection();const status=String(event.status||'pending');const res=await db.collection(COL).where({status}).orderBy('createdAt','asc').limit(200).get();return {success:true,list:res.data||[]}}
async function approve(event,adminOpenId){
  await ensureCollection()
  const id=String(event.id||'')
  const doc=(await db.collection(COL).doc(id).get()).data
  if(!doc||doc.status!=='pending')return {success:false,error:'申请不存在或已处理'}
  const roles=cleanRoles(doc.roles)
  const candidateRes=await db.collection('artist_candidates').where({artistId:Number(doc.artistId),status:'approved'}).limit(1).get().catch(()=>({data:[]}))
  if(candidateRes.data.length){
    const c=candidateRes.data[0]
    await db.collection('artist_candidates').doc(c._id).update({data:{artistName:doc.artistName,roles,avatarUrl:doc.avatarUrl,picUrl:doc.avatarUrl,heroImageUrl:doc.heroImageUrl,backgroundUrl:doc.heroImageUrl,coverUrl:doc.heroImageUrl,briefDesc:doc.briefDesc,description:doc.briefDesc,profileUpdatedAt:db.serverDate(),profileUpdatedBy:adminOpenId}})
  }
  const artistRes=await db.collection('artists').where({neteaseArtistId:String(doc.artistId)}).limit(1).get().catch(()=>({data:[]}))
  if(artistRes.data.length){
    const a=artistRes.data[0]
    await db.collection('artists').doc(a._id).update({data:{artistName:doc.artistName,name:doc.artistName,roles,avatarUrl:doc.avatarUrl,picUrl:doc.avatarUrl,heroImageUrl:doc.heroImageUrl,backgroundUrl:doc.heroImageUrl,coverUrl:doc.heroImageUrl,briefDesc:doc.briefDesc,description:doc.briefDesc,profileUpdatedAt:db.serverDate(),profileUpdatedBy:adminOpenId}})
  }
  if(!candidateRes.data.length&&!artistRes.data.length)return {success:false,error:'未找到该艺人'}
  await db.collection(COL).doc(id).update({data:{status:'approved',reviewedAt:db.serverDate(),reviewedBy:adminOpenId,updatedAt:db.serverDate()}})
  return {success:true}
}
async function reject(event,adminOpenId){await ensureCollection();const id=String(event.id||'');await db.collection(COL).doc(id).update({data:{status:'rejected',adminNote:String(event.adminNote||''),reviewedAt:db.serverDate(),reviewedBy:adminOpenId,updatedAt:db.serverDate()}});return {success:true}}
