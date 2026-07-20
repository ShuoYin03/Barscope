const cloud=require('wx-server-sdk')
const { isAdmin } = require('./_shared/auth')
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV})
const db=cloud.database()

exports.main=async event=>{
  const {OPENID}=cloud.getWXContext()
  const action=String(event.action||'submit')
  if(action==='submit') return submit(event,OPENID)
  if(!(await isAdmin(OPENID))) return {success:false,error:'unauthorized'}
  if(action==='list') return list(event)
  if(action==='approve') return approve(event,OPENID)
  if(action==='reject') return reject(event,OPENID)
  if(action==='stats') return stats()
  return {success:false,error:'unknown action'}
}

async function stats(){
  try {
    const r=await db.collection('track_corrections').where({status:'pending'}).count()
    return {success:true,pending:r.total||0}
  } catch (e) {
    return {success:false,error:e.message}
  }
}

async function submit(event,openId){
  if(!openId)return {success:false,error:'请先登录'}
  const albumId=String(event.albumId||'').trim()
  const albumTitle=String(event.albumTitle||'').trim()
  const tracks=Array.isArray(event.tracks)?event.tracks:[]
  if(!albumId||!tracks.length)return {success:false,error:'缺少曲目信息'}
  const pending=await db.collection('track_corrections').where({albumId,submitterOpenId:openId,status:'pending'}).limit(1).get()
  if(pending.data.length)return {success:false,error:'该专辑已有待审核申请'}
  const clean=tracks.map((t,i)=>({songId:String(t.songId||''),no:i+1,name:String(t.name||'').trim(),guests:(Array.isArray(t.guests)?t.guests:[]).map(g=>({id:Number(g.id||0),name:String(g.name||'').trim()})).filter(g=>g.name)}))
  if(clean.some(t=>!t.name))return {success:false,error:'曲目名称不能为空'}
  const userRes=await db.collection('users').where({openId}).limit(1).get()
  const user=userRes.data[0]||{}
  const add=await db.collection('track_corrections').add({data:{albumId,albumTitle,tracks:clean,status:'pending',submitterOpenId:openId,submitterName:user.nickName||'',createdAt:db.serverDate(),updatedAt:db.serverDate()}})
  return {success:true,id:add._id}
}

async function list(event){
  const status=String(event.status||'pending')
  const res=await db.collection('track_corrections').where({status}).orderBy('createdAt','desc').limit(100).get()
  return {success:true,list:res.data||[]}
}

async function approve(event,adminOpenId){
  const id=String(event.id||'')
  const doc=(await db.collection('track_corrections').doc(id).get()).data
  if(!doc||doc.status!=='pending')return {success:false,error:'申请不存在或已处理'}
  const album=(await db.collection('albums').doc(doc.albumId).get()).data
  if(!album)return {success:false,error:'专辑不存在'}
  const ownerArtists=(Array.isArray(album.ownerArtists)?album.ownerArtists:[]).map(o=>({id:Number(o&&o.id||0),name:String(o&&o.name||'').trim()})).filter(o=>o.name)
  const existingBySongId=new Map((Array.isArray(album.tracks)?album.tracks:[]).map(t=>[String(t.songId||''),t]))
  const tracks=doc.tracks.map((t,idx)=>{const old=existingBySongId.get(String(t.songId||''))||{};const guests=(t.guests||[]).map(g=>({id:Number(g.id||0),name:String(g.name||'').trim()})).filter(g=>g.name);const seen=new Set();const artists=[];ownerArtists.concat(guests).forEach(a=>{const k=a.id?'id:'+a.id:'name:'+a.name;if(!seen.has(k)){seen.add(k);artists.push(a)}});return {songId:String(t.songId||''),no:idx+1,name:String(t.name||old.name||'').trim(),duration:Number(old.duration||0),artists,guests,hasFeaturing:guests.length>0}})
  const featuringGuests=collectGuests(tracks)
  await db.collection('albums').doc(doc.albumId).update({data:{tracks,featuringGuests,trackCount:tracks.length}})
  await db.collection('track_corrections').doc(id).update({data:{status:'approved',reviewedAt:db.serverDate(),reviewedBy:adminOpenId,updatedAt:db.serverDate()}})
  return {success:true}
}

async function reject(event,adminOpenId){
  const id=String(event.id||'')
  await db.collection('track_corrections').doc(id).update({data:{status:'rejected',adminNote:String(event.adminNote||''),reviewedAt:db.serverDate(),reviewedBy:adminOpenId,updatedAt:db.serverDate()}})
  return {success:true}
}

function collectGuests(tracks){const map=new Map();tracks.forEach(track=>(track.guests||[]).forEach(g=>{const key=g.id?String(g.id):g.name;if(!map.has(key))map.set(key,{id:g.id||0,name:g.name,count:0,trackNos:[]});const x=map.get(key);x.count++;x.trackNos.push(track.no)}));return Array.from(map.values()).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name))}
