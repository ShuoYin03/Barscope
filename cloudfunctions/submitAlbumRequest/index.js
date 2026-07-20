const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const QQ_SEARCH_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const QQ_LEGACY_SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const QQ_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Referer':'https://y.qq.com/',
  'Origin':'https://y.qq.com',
}

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success:false, error:'请先登录' }
  const action = String(event.action || 'search')
  try {
    if (action === 'manual') return submitManual(event, OPENID)
    if (action === 'qq-search') return searchQQAndSubmit(event, OPENID)
    return searchAndSubmit(event, OPENID)
  } catch (e) {
    console.error('submitAlbumRequest failed:', e)
    return { success:false, error:e.message }
  }
}

async function searchAndSubmit(event, openId) {
  const keyword = String(event.name || '').trim()
  if (keyword.length < 1 || keyword.length > 80) return { success:false, error:'请输入有效的专辑名称' }
  const search = await getJson(`https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(keyword)}&type=10&offset=0&total=true&limit=10`)
  const albums = (search && search.result && search.result.albums) || []
  if (!albums.length) return { success:true, needsManual:true, searchedName:keyword }
  const normalized = normalize(keyword)
  const picked = albums.find(a => normalize(a.name) === normalized) || albums[0]
  const sourceId = String(picked.id || '')
  if (!sourceId) return { success:true, needsManual:true, searchedName:keyword }
  const duplicate = await findDuplicate(sourceId, 'netease')
  if (duplicate && duplicate.kind !== 'deleted_candidate') return duplicate
  const artists = Array.isArray(picked.artists) ? picked.artists : []
  const artistNames = artists.map(a => a && a.name).filter(Boolean)
  const artistIds = artists.map(a => String(a && a.id || '')).filter(Boolean)
  const publishTime = Number(picked.publishTime || 0)
  const published = publishTime ? new Date(publishTime) : null
  const releaseDate = published ? `${published.getUTCFullYear()}-${String(published.getUTCMonth()+1).padStart(2,'0')}-${String(published.getUTCDate()).padStart(2,'0')}` : ''
  const payload = {
    sourceId,sourceKey:`netease:${sourceId}`,source:'netease',sourcePlatform:'netease',submissionMode:'netease',
    title:String(picked.name || keyword),artist:artistNames.join(' / '),primaryArtist:artistNames[0] || '',
    neteaseArtistId:artistIds[0] || '',artistIds,releaseDate,releaseYear:published ? published.getUTCFullYear() : 0,
    coverUrl:String(picked.picUrl || picked.blurPicUrl || ''),company:String(picked.company || ''),tracks:[],
    avgScore:0,reviewCount:0,genres:[],status:'pending',decision:null,
    reportReason:duplicate && duplicate.kind === 'deleted_candidate' ? '用户申请重新收录已删除专辑（网易云匹配）' : '用户提交新专辑（网易云匹配）',
    reportSource:'discover-submit',requestSource:'discover-submit',requesterOpenId:openId,requestedName:keyword,foundFrom:'用户提交 · 网易云',
    reSubmittedAfterDeletion:!!(duplicate && duplicate.kind === 'deleted_candidate'),addedAt:db.serverDate(),decidedAt:null,decidedBy:null,
  }
  return saveCandidate(payload, duplicate)
}

async function searchQQAndSubmit(event, openId) {
  const keyword = String(event.name || '').trim()
  if (keyword.length < 1 || keyword.length > 80) return { success:false, error:'请输入有效的专辑名称' }

  let albums = await searchQQMusicu(keyword)
  let provider = 'musicu'
  if (!albums.length) {
    albums = await searchQQLegacy(keyword)
    provider = 'legacy'
  }

  console.log('[QQ SEARCH DEBUG]', {
    keyword,
    normalizedKeyword: normalize(keyword),
    provider,
    count: albums.length,
    albums: albums.map(a => ({
      title: a.title,
      normalizedTitle: normalize(a.title),
      albumMid: a.albumMid,
      albumId: a.albumId,
      singers: a.singers,
    })),
  })

  const exact = albums.filter(a => normalize(a.title) === normalize(keyword))
  console.log('[QQ SEARCH MATCH]', {
    keyword,
    provider,
    exactMatchCount: exact.length,
    exactMatches: exact.map(a => ({ title:a.title, albumMid:a.albumMid, singers:a.singers })),
  })
  if (!exact.length) return { success:true, needsManual:true, searchedName:keyword, qqResults:albums.slice(0,10), provider }

  const picked = exact[0]
  const sourceId = picked.albumMid
  const duplicate = await findDuplicate(sourceId, 'qq')
  if (duplicate && duplicate.kind !== 'deleted_candidate') return duplicate
  const artistNames = picked.singers.map(s => s.name).filter(Boolean)
  const qqArtistMids = picked.singers.map(s => s.mid).filter(Boolean)
  const payload = {
    sourceId,sourceKey:`qq:${sourceId}`,source:'qq',sourcePlatform:'qq',submissionMode:'qq',qqAlbumMid:sourceId,qqAlbumId:picked.albumId,
    qqAlbumUrl:`https://y.qq.com/n/ryqq_v2/albumDetail/${sourceId}`,qqArtistMid:qqArtistMids[0] || '',qqArtistMids,
    title:picked.title,artist:artistNames.join(' / '),primaryArtist:artistNames[0] || '',artistIds:[],ownerArtistIds:[],ownerArtists:[],
    releaseDate:'',releaseYear:0,coverUrl:`https://y.qq.com/music/photo_new/T002R800x800M000${sourceId}.jpg`,company:'',tracks:[],
    avgScore:0,reviewCount:0,genres:[],status:'pending',decision:null,
    reportReason:duplicate && duplicate.kind === 'deleted_candidate' ? '用户申请重新收录已删除专辑（QQ音乐匹配）' : '用户提交新专辑（QQ音乐匹配）',
    reportSource:'discover-submit',requestSource:'discover-submit',requesterOpenId:openId,requestedName:keyword,foundFrom:`用户提交 · QQ音乐 · ${provider}`,
    reSubmittedAfterDeletion:!!(duplicate && duplicate.kind === 'deleted_candidate'),addedAt:db.serverDate(),decidedAt:null,decidedBy:null,
  }
  const result = await saveCandidate(payload, duplicate)
  return {...result, qqAlbumMid:sourceId, qqArtistNames:artistNames, exactMatchCount:exact.length, provider}
}

async function searchQQMusicu(keyword) {
  const search = await postJson(QQ_SEARCH_URL, {
    comm:{ct:'19',cv:'1859',uin:'0'},
    req:{module:'music.search.SearchCgiService',method:'DoSearchForQQMusicDesktop',param:{query:keyword,search_type:2,num_per_page:20,page_num:1}},
  }, QQ_HEADERS)
  const rows = ((((((search || {}).req || {}).data || {}).body || {}).album || {}).list) || []
  return rows.map(row => normalizeQQAlbum(row && (row.album || row))).filter(Boolean)
}

async function searchQQLegacy(keyword) {
  const url = `${QQ_LEGACY_SEARCH_URL}?${new URLSearchParams({
    ct:'24',qqmusic_ver:'1298',new_json:'1',remoteplace:'txt.yqq.album',searchid:String(Date.now()),t:'8',aggr:'1',cr:'1',catZhida:'1',lossless:'0',flag_qc:'0',p:'1',n:'20',w:keyword,g_tk:'5381',loginUin:'0',hostUin:'0',format:'json',inCharset:'utf8',outCharset:'utf-8',notice:'0',platform:'yqq.json',needNewCode:'0'
  }).toString()}`
  const raw = await getJsonFlexible(url, QQ_HEADERS)
  const rows = (((raw || {}).data || {}).album || {}).list || []
  return rows.map(normalizeLegacyQQAlbum).filter(Boolean)
}

async function saveCandidate(payload, duplicate) {
  if (duplicate && duplicate.kind === 'deleted_candidate') {
    await db.collection('album_candidates').doc(duplicate.id).update({ data:payload })
    return { success:true, existed:false, reopened:true, albumTitle:payload.title, sourceId:payload.sourceId, submissionMode:payload.submissionMode }
  }
  await db.collection('album_candidates').add({ data:payload })
  return { success:true, existed:false, albumTitle:payload.title, sourceId:payload.sourceId, submissionMode:payload.submissionMode }
}

function normalizeQQAlbum(album) {
  if (!album || typeof album !== 'object') return null
  const title = String(album.albumName || album.album_name || album.title || album.name || '').trim()
  const albumMid = String(album.albumMID || album.album_mid || album.mid || '').trim()
  if (!title || !albumMid) return null
  const singerRows = album.singerList || album.singer_list || album.singer || []
  const singers = (Array.isArray(singerRows) ? singerRows : [singerRows]).map(s => ({
    name:String((s && (s.name || s.singerName || s.singer_name)) || '').trim(),
    mid:String((s && (s.mid || s.singerMID || s.singer_mid)) || '').trim(),
  })).filter(s => s.name || s.mid)
  return {title,albumMid,albumId:String(album.albumID || album.album_id || album.id || '').trim(),singers}
}

function normalizeLegacyQQAlbum(album) {
  if (!album || typeof album !== 'object') return null
  const title = String(album.albumName || album.album_name || album.name || '').replace(/<[^>]+>/g,'').trim()
  const albumMid = String(album.albumMID || album.album_mid || album.mid || '').trim()
  if (!title || !albumMid) return null
  let singerRows = album.singer || album.singerList || album.singer_list || []
  if (!Array.isArray(singerRows)) singerRows = [singerRows]
  let singers = singerRows.map(s => ({
    name:String((s && (s.name || s.singerName || s.singer_name)) || '').replace(/<[^>]+>/g,'').trim(),
    mid:String((s && (s.mid || s.singerMID || s.singer_mid)) || '').trim(),
  })).filter(s => s.name || s.mid)
  if (!singers.length) {
    const name = String(album.singerName || album.singer_name || '').trim()
    const mid = String(album.singerMID || album.singer_mid || '').trim()
    if (name || mid) singers = [{name,mid}]
  }
  return {title,albumMid,albumId:String(album.albumID || album.album_id || album.id || '').trim(),singers}
}

function sanitizeArtistRef(a) { const id=Number(a&&a.id)||0; const name=String(a&&a.name||'').trim(); return name?{id,name}:null }
function collectGuests(tracks) { const map=new Map(); tracks.forEach(track=>(track.guests||[]).forEach(g=>{const key=g.id?String(g.id):g.name;if(!map.has(key))map.set(key,{id:g.id||0,name:g.name,count:0,trackNos:[]});const x=map.get(key);x.count++;x.trackNos.push(track.no)}));return Array.from(map.values()).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name)) }

async function submitManual(event, openId) {
  const title=String(event.title||'').trim(),releaseDate=String(event.releaseDate||'').trim(),coverUrl=String(event.coverUrl||'').trim(),company=String(event.company||'').trim(),description=String(event.description||'').trim()
  const artistIds=Array.isArray(event.artistIds)?event.artistIds.map(x=>String(x||'').trim()).filter(Boolean).slice(0,20):[]
  const selectedArtists=(Array.isArray(event.selectedArtists)?event.selectedArtists.map(sanitizeArtistRef).filter(Boolean):[]).slice(0,20)
  const trackInputs=Array.isArray(event.tracks)?event.tracks.slice(0,100):[]
  if(!title)return{success:false,error:'请填写专辑名'}
  if(!selectedArtists.length)return{success:false,error:'请至少选择一位已收录歌手'}
  if(!coverUrl)return{success:false,error:'请上传专辑封面'}
  if(releaseDate&&!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate))return{success:false,error:'发行日期格式应为 YYYY-MM-DD'}
  const tracks=trackInputs.map((t,index)=>{const name=String(t&&t.name||'').trim();const guests=(Array.isArray(t&&t.guests)?t.guests.map(sanitizeArtistRef).filter(Boolean):[]).slice(0,20);return{no:index+1,name,artists:selectedArtists,guests,hasFeaturing:guests.length>0}}).filter(t=>t.name)
  if(!tracks.length)return{success:false,error:'请至少填写一首曲目'}
  const artist=selectedArtists.map(a=>a.name).join(' / '),primaryArtist=selectedArtists[0].name,neteaseArtistId=artistIds[0]||String(selectedArtists[0].id||''),featuringGuests=collectGuests(tracks)
  const existing=await db.collection('album_candidates').where({title,artist,status:'pending'}).limit(1).get()
  if(existing.data.length)return{success:true,existed:true,status:'pending',albumTitle:title}
  const sourceId=`manual_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
  await db.collection('album_candidates').add({data:{sourceId,submissionMode:'manual',manualSubmission:true,title,artist,primaryArtist,neteaseArtistId,artistIds,releaseDate,releaseYear:releaseDate?Number(releaseDate.slice(0,4)):0,coverUrl,company,description,tracks,trackCount:tracks.length,featuringGuests,avgScore:0,reviewCount:0,genres:[],status:'pending',reportReason:'用户手动提交下架或网易云无法检索的专辑',reportSource:'discover-submit-manual',requestSource:'discover-submit-manual',requesterOpenId:openId,requestedName:title,foundFrom:'用户手动提交',addedAt:db.serverDate(),decidedAt:null}})
  return{success:true,existed:false,albumTitle:title,sourceId,submissionMode:'manual'}
}

async function findDuplicate(sourceId, sourcePlatform='') {
  const sourceKey=sourcePlatform?`${sourcePlatform}:${sourceId}`:''
  const [existingAlbum,existingCandidate]=await Promise.all([
    db.collection('albums').where(sourceKey?db.command.or([{sourceId},{sourceKey}]):{sourceId}).limit(1).get(),
    db.collection('album_candidates').where(sourceKey?db.command.or([{sourceId},{sourceKey}]):{sourceId}).limit(1).get(),
  ])
  if(existingAlbum.data.length)return{success:true,existed:true,status:'approved',albumTitle:existingAlbum.data[0].title||'',kind:'album'}
  if(existingCandidate.data.length){const row=existingCandidate.data[0];if(row.status==='deleted')return{kind:'deleted_candidate',id:row._id,row};return{success:true,existed:true,status:row.status||'pending',albumTitle:row.title||'',kind:'candidate'}}
  return null
}

function normalize(value){return String(value||'').trim().toLowerCase().replace(/explicit/gi,'').replace(/[\s\-_·•.。'"“”‘’()（）\[\]【】/\\?!！？，,:：]+/g,'')}
function getJson(url){return new Promise((resolve,reject)=>{const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://music.163.com/'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{resolve(JSON.parse(body))}catch(e){resolve(null)}})});req.on('error',reject);req.setTimeout(10000,()=>{req.destroy();reject(new Error('网易云请求超时'))})})}
function postJson(url,body,headers={}){return new Promise((resolve,reject)=>{const data=Buffer.from(JSON.stringify(body));const target=new URL(url);const req=https.request({protocol:target.protocol,hostname:target.hostname,path:target.pathname+target.search,method:'POST',headers:{'Content-Type':'application/json','Content-Length':data.length,...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text))}catch(e){reject(new Error('QQ音乐主搜索接口返回格式异常'))}})});req.on('error',reject);req.setTimeout(15000,()=>{req.destroy();reject(new Error('QQ音乐请求超时'))});req.write(data);req.end()})}
function getJsonFlexible(url,headers={}){return new Promise((resolve,reject)=>{const req=https.get(url,{headers},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{const trimmed=text.trim();const jsonText=trimmed.startsWith('{')?trimmed:trimmed.replace(/^[^(]*\(/,'').replace(/\)\s*;?$/,'');try{resolve(JSON.parse(jsonText))}catch(e){reject(new Error('QQ音乐备用搜索接口返回格式异常'))}})});req.on('error',reject);req.setTimeout(15000,()=>{req.destroy();reject(new Error('QQ音乐备用接口请求超时'))})})}
