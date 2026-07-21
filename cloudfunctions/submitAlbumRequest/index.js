const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const QQ_SEARCH_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const QQ_ALBUM_INFO_URL = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg'
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
    return { success:false, error:e && e.message ? e.message : '提交失败' }
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
    coverUrl:String(picked.picUrl || picked.blurPicUrl || ''),company:String(picked.company || ''),tracks:[],trackCount:0,
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

  const albums = await searchQQMusicu(keyword)
  const provider = 'musicu'

  const exact = albums.filter(a => normalize(a.title) === normalize(keyword))
  if (!exact.length) return { success:true, needsManual:true, searchedName:keyword, qqResults:albums.slice(0,10), provider }

  const picked = exact[0]
  const sourceId = picked.albumMid
  const duplicate = await findDuplicate(sourceId, 'qq')
  if (duplicate && duplicate.kind !== 'deleted_candidate') return duplicate

  const [detail, tracks] = await Promise.all([
    fetchQQAlbumDetail(sourceId).catch(() => ({})),
    fetchQQAlbumTracks(sourceId).catch(() => []),
  ])

  // 专辑归属只使用“专辑级歌手”，绝不能递归扫详情里的所有 track singer，
  // 否则 featuring artist 会被误当成专辑 owner。
  const albumSingers = dedupeSingers(picked.singers.length ? picked.singers : extractTopLevelAlbumSingers(detail))
  const ownership = await resolveBarScopeOwners(albumSingers)
  const canonicalOwners = ownership.ownerArtists
  const ownerNames = canonicalOwners.length ? canonicalOwners.map(x => x.name) : albumSingers.map(x => x.name).filter(Boolean)
  const ownerQQMids = new Set(albumSingers.map(x => String(x.mid || '')).filter(Boolean))
  const ownerNameKeys = new Set([...albumSingers.map(x => normalize(x.name)), ...ownerNames.map(normalize)].filter(Boolean))

  const releaseDate = firstReleaseDate(detail) || normalizeReleaseDate(picked.publishDate || '')
  const releaseYear = releaseDate ? Number((releaseDate.match(/(?:19|20)\d{2}/) || [0])[0]) : 0
  const company = String(findFirstField(detail, ['company','company_name','companyName','label','record_company','recordCompany']) || picked.company || '').trim()
  const description = cleanText(findFirstField(detail, ['desc','description','album_desc','albumDesc','intro']) || '')
  const genre = String(findFirstField(detail, ['genre','genre_name','genreName','album_type','albumType']) || '').trim()

  const normalizedTracks = tracks.map((track, index) => {
    const songArtists = (track.singers || []).map(s => ({ id:0, name:s.name, qqArtistMid:s.mid || '' })).filter(a => a.name)
    const guests = songArtists
      .filter(a => !(a.qqArtistMid && ownerQQMids.has(String(a.qqArtistMid))) && !ownerNameKeys.has(normalize(a.name)))
      .map(a => ({ id:0, name:a.name }))
    return {
      no:index + 1,
      name:track.name,
      artists:songArtists.map(a => ({ id:a.id, name:a.name })),
      guests,
      hasFeaturing:guests.length > 0,
      duration:track.duration || 0,
      durationMs:track.durationMs || 0,
      qqSongMid:track.mid || '',
    }
  })

  const qqArtistMids = albumSingers.map(s => s.mid).filter(Boolean)
  const title = String(findFirstField(detail, ['album_name','albumName','name','title']) || picked.title)
  const payload = {
    sourceId,sourceKey:`qq:${sourceId}`,source:'qq',sourcePlatform:'qq',submissionMode:'qq',qqAlbumMid:sourceId,qqAlbumId:picked.albumId,
    qqAlbumUrl:`https://y.qq.com/n/ryqq_v2/albumDetail/${sourceId}`,qqArtistMid:qqArtistMids[0] || '',qqArtistMids,
    title,
    artist:ownerNames.join(' / '),primaryArtist:ownerNames[0] || '',
    neteaseArtistId:ownership.artistIds[0] || '',
    artistIds:ownership.artistIds,
    ownerArtistIds:ownership.artistIds,
    ownerArtists:canonicalOwners.map(x => ({ id:x.id, name:x.name })),
    releaseDate,releaseYear,
    coverUrl:`https://y.qq.com/music/photo_new/T002R800x800M000${sourceId}.jpg`,
    company,description,
    tracks:normalizedTracks,trackCount:normalizedTracks.length,
    featuringGuests:collectGuests(normalizedTracks),
    avgScore:0,reviewCount:0,genres:genre ? [genre] : [],status:'pending',decision:null,
    reportReason:duplicate && duplicate.kind === 'deleted_candidate' ? '用户申请重新收录已删除专辑（QQ音乐完整匹配）' : '用户提交新专辑（QQ音乐完整匹配）',
    reportSource:'discover-submit',requestSource:'discover-submit',requesterOpenId:openId,requestedName:keyword,foundFrom:`用户提交 · QQ音乐 · ${provider}`,
    metadataCompleteness:{ releaseDate:!!releaseDate, company:!!company, tracks:normalizedTracks.length, ownerArtistIds:ownership.artistIds.length },
    reSubmittedAfterDeletion:!!(duplicate && duplicate.kind === 'deleted_candidate'),addedAt:db.serverDate(),decidedAt:null,decidedBy:null,
  }
  console.log('[QQ ENRICHED]', { title, releaseDate, company, owners:payload.ownerArtists, trackCount:payload.trackCount, featuringGuests:payload.featuringGuests.length })
  const result = await saveCandidate(payload, duplicate)
  return {...result, qqAlbumMid:sourceId, qqArtistNames:ownerNames, exactMatchCount:exact.length, provider, trackCount:payload.trackCount, releaseDate}
}

async function resolveBarScopeOwners(qqSingers) {
  const allArtistsRes = await db.collection('artist_candidates').where({status:'approved'})
    .field({_id:true,artistId:true,artistName:true,aliases:true,aka:true})
    .limit(1000).get()
  const artists = (allArtistsRes.data || []).filter(a => a.artistId && a.artistName)
  const byArtistId = new Map(artists.map(a => [String(a.artistId), a]))
  const resolved = []

  for (const singer of qqSingers) {
    let hit = null
    const mid = String(singer.mid || '').trim()

    // 最可靠：已经建立过 QQ 身份的专辑，用 qqArtistMid 反查 BarScope/网易云 artistId。
    if (mid) {
      const albumRes = await db.collection('albums').where({ qqArtistMid:mid })
        .field({_id:true,neteaseArtistId:true,artistIds:true,primaryArtist:true}).limit(1).get()
      const album = albumRes.data && albumRes.data[0]
      if (album) {
        const ids = [album.neteaseArtistId, ...(Array.isArray(album.artistIds) ? album.artistIds : [])].map(String).filter(Boolean)
        for (const id of ids) { if (byArtistId.has(id)) { hit = byArtistId.get(id); break } }
      }
    }

    // 回退：用 BarScope canonical name / aliases / aka 做标准化匹配。
    if (!hit) {
      const q = normalize(singer.name)
      hit = artists.find(a => {
        const names = [a.artistName, a.aka, ...(Array.isArray(a.aliases) ? a.aliases : [])]
        return names.some(name => normalize(name) === q)
      }) || null
    }

    if (hit && !resolved.some(x => String(x.id) === String(hit.artistId))) {
      resolved.push({ id:String(hit.artistId), name:String(hit.artistName) })
    }
  }

  return { artistIds:resolved.map(x => x.id), ownerArtists:resolved }
}

async function searchQQMusicu(keyword) {
  const search = await postJson(QQ_SEARCH_URL, {
    comm:{ct:'19',cv:'1859',uin:'0'},
    req:{module:'music.search.SearchCgiService',method:'DoSearchForQQMusicDesktop',param:{query:keyword,search_type:2,num_per_page:20,page_num:1}},
  }, QQ_HEADERS)
  const rows = ((((((search || {}).req || {}).data || {}).body || {}).album || {}).list) || []
  return rows.map(row => normalizeQQAlbum(row && (row.album || row))).filter(Boolean)
}

async function fetchQQAlbumDetail(albumMid) {
  const url = `${QQ_ALBUM_INFO_URL}?${new URLSearchParams({albummid:albumMid,format:'json',platform:'yqq',newsong:'1'}).toString()}`
  return getJsonFlexible(url, QQ_HEADERS)
}

async function fetchQQAlbumTracks(albumMid) {
  const raw = await postJson(QQ_SEARCH_URL, {comm:{ct:24,cv:0},albumSongList:{module:'music.musichallAlbum.AlbumSongList',method:'GetAlbumSongList',param:{albumMid,begin:0,num:500,order:2}}}, QQ_HEADERS)
  const body = (((raw || {}).albumSongList || {}).data || {})
  const rows = body.songList || body.list || body.songs || []
  const tracks = extractTrackRows(rows)
  if (tracks.length) return tracks
  const legacy = await fetchQQAlbumDetail(albumMid)
  const data = (legacy && legacy.data) || {}
  return extractTrackRows(data.list || data.songlist || data.songList || data.songs || [])
}

function extractTrackRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    const song = row && (row.songInfo || row.songinfo || row.musicData || row.data || row)
    if (!song || typeof song !== 'object') return null
    const name = String(song.title || song.songname || song.songName || song.name || '').trim()
    if (!name) return null
    const singerRows = song.singer || song.singerList || song.singer_list || []
    const singers = (Array.isArray(singerRows) ? singerRows : [singerRows]).map(s => ({name:String((s && (s.name || s.singerName || s.singer_name)) || '').trim(),mid:String((s && (s.mid || s.singerMID || s.singer_mid)) || '').trim()})).filter(s => s.name || s.mid)
    const seconds = Number(song.interval || song.duration || 0) || 0
    return { name, mid:String(song.mid || song.songmid || song.songMid || ''), singers, duration:seconds, durationMs:seconds*1000 }
  }).filter(Boolean)
}

function extractTopLevelAlbumSingers(payload) {
  const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : payload
  if (!data || typeof data !== 'object') return []
  const rows = data.singer || data.singerList || data.singer_list || []
  return (Array.isArray(rows) ? rows : [rows]).map(s => ({name:String((s && (s.name || s.singerName || s.singer_name)) || '').trim(),mid:String((s && (s.mid || s.singerMID || s.singer_mid)) || '').trim()})).filter(s => s.name || s.mid)
}

function dedupeSingers(rows) {
  const seen = new Set()
  return (rows || []).filter(s => { const key=String(s.mid || '') || normalize(s.name); if(!key || seen.has(key)) return false; seen.add(key); return true })
}

function firstReleaseDate(payload) {
  const preferred = ['pub_time','publish_date','publishDate','publicTime','publictime','release_date','releaseDate','date','time_public']
  function find(value) {
    if (Array.isArray(value)) { for (const child of value) { const r=find(child); if(r) return r } return '' }
    if (!value || typeof value !== 'object') return ''
    for (const key of preferred) {
      const raw = value[key]
      if (raw !== undefined && raw !== null) {
        const date = normalizeReleaseDate(raw)
        if (date) return date
      }
    }
    for (const child of Object.values(value)) { const r=find(child); if(r) return r }
    return ''
  }
  return find(payload)
}

function findFirstField(value, keys) {
  if (!value || typeof value !== 'object') return ''
  if (!Array.isArray(value)) {
    for (const key of keys) { const raw=value[key]; if(raw!==undefined&&raw!==null&&typeof raw!=='object'&&String(raw).trim()) return raw }
    for (const child of Object.values(value)) { const found=findFirstField(child,keys); if(found!=='') return found }
  } else {
    for (const child of value) { const found=findFirstField(child,keys); if(found!=='') return found }
  }
  return ''
}

function normalizeReleaseDate(value) {
  const text = String(value || '').trim()
  const m = text.match(/((?:19|20)\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`
  const compact = text.match(/^((?:19|20)\d{2})(\d{2})(\d{2})$/)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  const year = text.match(/(?:19|20)\d{2}/)
  return year ? year[0] : ''
}

function cleanText(value) { return String(value || '').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/gi,' ').trim() }

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
  const singers = (Array.isArray(singerRows) ? singerRows : [singerRows]).map(s => ({name:String((s && (s.name || s.singerName || s.singer_name)) || '').trim(),mid:String((s && (s.mid || s.singerMID || s.singer_mid)) || '').trim()})).filter(s => s.name || s.mid)
  return {title,albumMid,albumId:String(album.albumID || album.album_id || album.id || '').trim(),singers,publishDate:String(album.pub_time || album.publish_date || album.publishDate || album.publicTime || album.date || '').trim(),company:String(album.company || album.label || '').trim()}
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
  await db.collection('album_candidates').add({data:{sourceId,submissionMode:'manual',manualSubmission:true,title,artist,primaryArtist,neteaseArtistId,artistIds,ownerArtistIds:artistIds,ownerArtists:selectedArtists,releaseDate,releaseYear:releaseDate?Number(releaseDate.slice(0,4)):0,coverUrl,company,description,tracks,trackCount:tracks.length,featuringGuests,avgScore:0,reviewCount:0,genres:[],status:'pending',reportReason:'用户手动提交下架或网易云无法检索的专辑',reportSource:'discover-submit-manual',requestSource:'discover-submit-manual',requesterOpenId:openId,requestedName:title,foundFrom:'用户手动提交',addedAt:db.serverDate(),decidedAt:null}})
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
function postJson(url,body,headers={}){return new Promise((resolve,reject)=>{const data=Buffer.from(JSON.stringify(body));const target=new URL(url);const req=https.request({protocol:target.protocol,hostname:target.hostname,path:target.pathname+target.search,method:'POST',headers:{'Content-Type':'application/json','Content-Length':data.length,...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{resolve(JSON.parse(text))}catch(e){reject(new Error('QQ音乐主搜索接口返回格式异常'))}})});req.on('error',reject);req.setTimeout(15000,()=>{req.destroy(new Error('QQ音乐请求超时'))});req.write(data);req.end()})}
function getJsonFlexible(url,headers={}){return new Promise((resolve,reject)=>{const req=https.get(url,{headers},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{const trimmed=text.trim();const jsonText=trimmed.startsWith('{')?trimmed:trimmed.replace(/^[^(]*\(/,'').replace(/\)\s*;?$/,'');try{resolve(JSON.parse(jsonText))}catch(e){reject(new Error('QQ音乐接口返回格式异常'))}})});req.on('error',reject);req.setTimeout(15000,()=>{req.destroy(new Error('QQ音乐接口请求超时'))})})}