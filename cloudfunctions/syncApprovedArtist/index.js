const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV})
const db=cloud.database()
exports.main=async event=>{
 const {OPENID}=cloud.getWXContext(); const artistId=String(event.artistId||''); if(!artistId)return{success:false,error:'missing artistId'}
 const admin=await db.collection('users').where({openId:OPENID,type:'admin'}).limit(1).get(); if(!admin.data.length)return{success:false,error:'unauthorized'}
 try{
  const detail=await getJson(`https://music.163.com/api/v1/artist/${artistId}`); const a=(detail&&detail.artist)||{}; const name=String(a.name||event.artistName||'').trim(); const avatar=a.img1v1Url||a.picUrl||''; const hero=a.picUrl||a.img1v1Url||avatar;
  const patch={artistName:name,picUrl:avatar,avatarUrl:avatar,coverUrl:hero,backgroundUrl:hero,heroImageUrl:hero,albumSize:Number(a.albumSize||0),musicSize:Number(a.musicSize||0),metadataSyncedAt:db.serverDate()};
  const candidates=await db.collection('artist_candidates').where({artistId:Number(artistId)}).limit(1).get(); if(candidates.data.length)await db.collection('artist_candidates').doc(candidates.data[0]._id).update({data:patch});
  const profile={neteaseArtistId:artistId,artistId:Number(artistId),name,artistName:name,...patch}; const exist=await db.collection('artists').where({neteaseArtistId:artistId}).limit(1).get(); if(exist.data.length)await db.collection('artists').doc(exist.data[0]._id).update({data:profile});else await db.collection('artists').add({data:profile});
  return{success:true,name,avatarUrl:avatar,heroImageUrl:hero}
 }catch(e){return{success:false,error:e.message}}
}
function getJson(url){return new Promise((resolve,reject)=>{const r=https.get(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://music.163.com/'}},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>{try{resolve(JSON.parse(b))}catch(e){resolve(null)}})});r.on('error',reject);r.setTimeout(10000,()=>{r.destroy();reject(new Error('timeout'))})})}
