const cloud=require('wx-server-sdk')
const https=require('https')
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV})
const db=cloud.database()
const SEARCH='https://u.y.qq.com/cgi-bin/musicu.fcg'
const LEGACY='https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const DETAIL='https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg'
const HEADERS={'User-Agent':'Mozilla/5.0','Referer':'https://y.qq.com/','Origin':'https://y.qq.com'}

exports.main=async event=>{
  const {OPENID}=cloud.getWXContext()
  if(!OPENID)return{success:false,error:'请先登录'}
  const keyword=String(event.name||'').trim()
  if(!keyword)return{success:false,error:'请输入专辑名称'}
  try{
    const picked=await findAlbum(keyword)
    if(!picked)return{success:true,needsManual:true,searchedName:keyword}
    const sourceId=picked.albumMid
    const duplicate=await findDuplicate(sourceId)
    if(duplicate)return duplicate
    const [detail,tracks]=await Promise.all([fetchDetail(sourceId).catch(()=>({})),fetchTracks(sourceId).catch(()=>[])])
    const singers=(picked.singers||[]).filter(x=>x.name||x.mid)
    const owners=await resolveOwners(singers)
    const ownerNames=owners.length?owners.map(x=>x.name):singers.map(x=>x.name).filter(Boolean)
    const ownerMidSet=new Set(singers.map(x=>String(x.mid||'')).filter(Boolean))
    const ownerNameSet=new Set(ownerNames.map(normalize))
    const normalizedTracks=tracks.map((t,i)=>{
      const artists=(t.singers||[]).map(s=>({id:0,name:s.name,qqArtistMid:s.mid||''})).filter(x=>x.name)
      const guests=artists.filter(a=>!(a.qqArtistMid&&ownerMidSet.has(a.qqArtistMid))&&!ownerNameSet.has(normalize(a.name))).map(a=>({id:0,name:a.name}))
      return{no:i+1,name:t.name,artists:artists.map(a=>({id:a.id,name:a.name})),guests,hasFeaturing:guests.length>0,duration:t.duration||0,durationMs:(t.duration||0)*1000,qqSongMid:t.mid||''}
    })
    const releaseDate=findDate(detail)||picked.publishDate||''
    const releaseYear=Number((String(releaseDate).match(/(?:19|20)\d{2}/)||[0])[0])||0
    const title=findField(detail,['album_name','albumName','name','title'])||picked.title||keyword
    const company=findField(detail,['company','company_name','companyName','label','record_company','recordCompany'])||picked.company||''
    const description=cleanText(findField(detail,['desc','description','album_desc','albumDesc','intro'])||'')
    const payload={sourceId,sourceKey:`qq:${sourceId}`,source:'qq',sourcePlatform:'qq',submissionMode:'qq',qqAlbumMid:sourceId,qqAlbumId:picked.albumId||'',qqAlbumUrl:`https://y.qq.com/n/ryqq_v2/albumDetail/${sourceId}`,qqArtistMid:singers[0]?.mid||'',qqArtistMids:singers.map(x=>x.mid).filter(Boolean),title,artist:ownerNames.join(' / '),primaryArtist:ownerNames[0]||'',neteaseArtistId:owners[0]?.id||'',artistIds:owners.map(x=>x.id),ownerArtistIds:owners.map(x=>x.id),ownerArtists:owners.map(x=>({id:x.id,name:x.name})),releaseDate,releaseYear,coverUrl:`https://y.qq.com/music/photo_new/T002R800x800M000${sourceId}.jpg`,company:String(company).trim(),description,tracks:normalizedTracks,trackCount:normalizedTracks.length,featuringGuests:collectGuests(normalizedTracks),avgScore:0,reviewCount:0,genres:[],status:'pending',decision:null,reportReason:'用户提交新专辑（QQ音乐增强检索）',reportSource:'discover-submit',requestSource:'discover-submit',requesterOpenId:OPENID,requestedName:keyword,foundFrom:`用户提交 · QQ音乐 · ${picked.provider||'fallback'}`,addedAt:db.serverDate(),decidedAt:null,decidedBy:null}
    const add=await db.collection('album_candidates').add({data:payload})
    return{success:true,existed:false,id:add._id,albumTitle:title,qqAlbumMid:sourceId,trackCount:normalizedTracks.length}
  }catch(e){console.error(e);return{success:false,error:e&&e.message?e.message:'QQ音乐查询失败'}}
}

async function findAlbum(keyword){
  const target=normalize(keyword)
  const merged=[]
  for(let page=1;page<=3;page++){
    const raw=await postJson(SEARCH,{comm:{ct:'19',cv:'1859',uin:'0'},req:{module:'music.search.SearchCgiService',method:'DoSearchForQQMusicDesktop',param:{query:keyword,search_type:2,num_per_page:30,page_num:page}}},HEADERS).catch(()=>null)
    const rows=((((raw||{}).req||{}).data||{}).body||{}).album?.list||[]
    merged.push(...rows.map(x=>normalizeAlbum(x&& (x.album||x),'musicu')).filter(Boolean))
  }
  let hit=merged.find(a=>normalize(a.title)===target)
  if(hit)return hit
  for(let page=1;page<=3;page++){
    const url=`${LEGACY}?${new URLSearchParams({ct:'24',qqmusic_ver:'1298',new_json:'1',remoteplace:'txt.yqq.album',searchid:String(Date.now()),t:'8',aggr:'1',cr:'1',catZhida:'1',lossless:'0',flag_qc:'0',p:String(page),n:'30',w:keyword,g_tk:'5381',loginUin:'0',hostUin:'0',format:'json',inCharset:'utf8',outCharset:'utf-8',notice:'0',platform:'yqq.json',needNewCode:'0'}).toString()}`
    const raw=await getJson(url).catch(()=>null)
    const rows=(((raw||{}).data||{}).album||{}).list||[]
    const list=rows.map(x=>normalizeAlbum(x,'legacy')).filter(Boolean)
    hit=list.find(a=>normalize(a.title)===target)
    if(hit)return hit
  }
  for(let page=1;page<=3;page++){
    const raw=await postJson(SEARCH,{comm:{ct:'19',cv:'1859',uin:'0'},req:{module:'music.search.SearchCgiService',method:'DoSearchForQQMusicDesktop',param:{query:keyword,search_type:0,num_per_page:50,page_num:page}}},HEADERS).catch(()=>null)
    const songs=(((((raw||{}).req||{}).data||{}).body||{}).song||{}).list||[]
    for(const row of songs){
      const song=row&& (row.songInfo||row)
      const album=song&&song.album
      if(!album)continue
      const title=String(album.name||album.title||album.albumName||'').trim()
      const mid=String(album.mid||album.albumMid||album.albumMID||'').trim()
      if(title&&mid&&normalize(title)===target){
        const singers=(song.singer||[]).map(s=>({name:String(s.name||'').trim(),mid:String(s.mid||'').trim()})).filter(s=>s.name||s.mid)
        return{title,albumMid:mid,albumId:String(album.id||''),singers,publishDate:'',company:'',provider:'song-fallback'}
      }
    }
  }
  return null
}

function normalizeAlbum(album,provider){if(!album||typeof album!=='object')return null;const title=String(album.albumName||album.album_name||album.title||album.name||'').replace(/<[^>]+>/g,'').trim();const albumMid=String(album.albumMID||album.album_mid||album.mid||'').trim();if(!title||!albumMid)return null;let rows=album.singerList||album.singer_list||album.singer||[];if(!Array.isArray(rows))rows=[rows];let singers=rows.map(s=>({name:String(s&&(s.name||s.singerName||s.singer_name)||'').replace(/<[^>]+>/g,'').trim(),mid:String(s&&(s.mid||s.singerMID||s.singer_mid)||'').trim()})).filter(s=>s.name||s.mid);if(!singers.length){const name=String(album.singerName||album.singer_name||'').trim(),mid=String(album.singerMID||album.singer_mid||'').trim();if(name||mid)singers=[{name,mid}]}return{title,albumMid,albumId:String(album.albumID||album.album_id||album.id||''),singers,publishDate:String(album.pub_time||album.publish_date||album.publishDate||album.publicTime||album.date||''),company:String(album.company||album.label||''),provider}}
async function fetchDetail(mid){return getJson(`${DETAIL}?${new URLSearchParams({albummid:mid,format:'json',platform:'yqq',newsong:'1'}).toString()}`)}
async function fetchTracks(mid){const raw=await postJson(SEARCH,{comm:{ct:24,cv:0},albumSongList:{module:'music.musichallAlbum.AlbumSongList',method:'GetAlbumSongList',param:{albumMid:mid,begin:0,num:500,order:2}}},HEADERS);const rows=((raw||{}).albumSongList||{}).data?.songList||[];return rows.map(r=>{const s=r&&(r.songInfo||r);const singers=(s.singer||[]).map(x=>({name:String(x.name||''),mid:String(x.mid||'')}));return{name:String(s.title||s.name||''),mid:String(s.mid||''),duration:Number(s.interval||0),singers}}).filter(x=>x.name)}
async function resolveOwners(singers){const out=[];for(const s of singers){let a=null;if(s.mid){const r=await db.collection('artists').where({qqArtistMid:String(s.mid)}).limit(1).get().catch(()=>({data:[]}));a=r.data&&r.data[0]}if(!a){const r=await db.collection('artist_candidates').where({artistName:String(s.name),status:'approved'}).limit(1).get().catch(()=>({data:[]}));a=r.data&&r.data[0]}if(a&&!out.some(x=>String(x.id)===String(a.artistId||a.neteaseArtistId))){out.push({id:String(a.artistId||a.neteaseArtistId||''),name:String(a.artistName||a.name||s.name)})}}return out.filter(x=>x.id)}
async function findDuplicate(sourceId){const key=`qq:${sourceId}`;const [a,c]=await Promise.all([db.collection('albums').where(db.command.or([{sourceId},{sourceKey:key}])).limit(1).get(),db.collection('album_candidates').where(db.command.or([{sourceId},{sourceKey:key}])).limit(1).get()]);if(a.data.length)return{success:true,existed:true,status:'approved',albumTitle:a.data[0].title||''};if(c.data.length)return{success:true,existed:true,status:c.data[0].status||'pending',albumTitle:c.data[0].title||''};return null}
function normalize(v){return String(v||'').toLowerCase().normalize('NFKC').replace(/explicit/gi,'').replace(/<[^>]+>/g,'').replace(/[\s\-_·•.。'"“”‘’()（）\[\]【】/\\?!！？，,:：]+/g,'')}
function findDate(v){const s=JSON.stringify(v||{});const m=s.match(/(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/);return m?m[0].replace(/[/.]/g,'-'):''}
function findField(v,keys){if(!v||typeof v!=='object')return'';if(!Array.isArray(v)){for(const k of keys){if(v[k]!=null&&typeof v[k]!=='object'&&String(v[k]).trim())return v[k]}}for(const c of Object.values(v)){const x=findField(c,keys);if(x!=='')return x}return''}
function cleanText(v){return String(v||'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/gi,' ').trim()}
function collectGuests(tracks){const map=new Map();tracks.forEach(t=>(t.guests||[]).forEach(g=>{const k=g.name;if(!map.has(k))map.set(k,{id:g.id||0,name:g.name,count:0,trackNos:[]});const x=map.get(k);x.count++;x.trackNos.push(t.no)}));return[...map.values()]}
function postJson(url,body,headers={}){return new Promise((resolve,reject)=>{const data=Buffer.from(JSON.stringify(body));const u=new URL(url);const req=https.request({hostname:u.hostname,path:u.pathname+u.search,method:'POST',headers:{'Content-Type':'application/json','Content-Length':data.length,...headers}},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>{try{resolve(JSON.parse(t))}catch(e){reject(e)}})});req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error('QQ音乐请求超时')));req.write(data);req.end()})}
function getJson(url){return new Promise((resolve,reject)=>{const req=https.get(url,{headers:HEADERS},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>{const s=t.trim().replace(/^[^(]*\(/,'').replace(/\)\s*;?$/,'');try{resolve(JSON.parse(s))}catch(e){reject(e)}})});req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error('QQ音乐请求超时')))})}
