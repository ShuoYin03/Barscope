const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success:false, error:'请先登录' }
  const action = String(event.action || 'search')
  try {
    if (action === 'manual') return submitManual(event, OPENID)
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

  const duplicate = await findDuplicate(sourceId)
  if (duplicate) return duplicate

  const artists = Array.isArray(picked.artists) ? picked.artists : []
  const artistNames = artists.map(a => a && a.name).filter(Boolean)
  const artistIds = artists.map(a => String(a && a.id || '')).filter(Boolean)
  const publishTime = Number(picked.publishTime || 0)
  const published = publishTime ? new Date(publishTime) : null
  const releaseDate = published ? `${published.getUTCFullYear()}-${String(published.getUTCMonth()+1).padStart(2,'0')}-${String(published.getUTCDate()).padStart(2,'0')}` : ''
  const releaseYear = published ? published.getUTCFullYear() : 0

  await db.collection('album_candidates').add({ data:{
    sourceId,
    submissionMode:'netease',
    title:String(picked.name || keyword),
    artist:artistNames.join(' / '),
    primaryArtist:artistNames[0] || '',
    neteaseArtistId:artistIds[0] || '',
    artistIds,
    releaseDate,
    releaseYear,
    coverUrl:String(picked.picUrl || picked.blurPicUrl || ''),
    company:String(picked.company || ''),
    tracks:[],
    avgScore:0,
    reviewCount:0,
    genres:[],
    status:'pending',
    reportReason:'用户提交新专辑（网易云匹配）',
    reportSource:'discover-submit',
    requestSource:'discover-submit',
    requesterOpenId:openId,
    requestedName:keyword,
    foundFrom:'用户提交',
    addedAt:db.serverDate(),
    decidedAt:null,
  } })
  return { success:true, existed:false, albumTitle:String(picked.name || keyword), sourceId, submissionMode:'netease' }
}

async function submitManual(event, openId) {
  const title = String(event.title || '').trim()
  const artist = String(event.artist || '').trim()
  const releaseDate = String(event.releaseDate || '').trim()
  const coverUrl = String(event.coverUrl || '').trim()
  const company = String(event.company || '').trim()
  const description = String(event.description || '').trim()
  const trackNames = Array.isArray(event.tracks) ? event.tracks.map(x => String(x || '').trim()).filter(Boolean).slice(0,100) : []
  const artistIds = Array.isArray(event.artistIds) ? event.artistIds.map(x => String(x || '').trim()).filter(Boolean).slice(0,20) : []
  if (!title || !artist) return { success:false, error:'请填写专辑名和歌手' }
  if (!coverUrl) return { success:false, error:'请上传专辑封面' }
  if (releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return { success:false, error:'发行日期格式应为 YYYY-MM-DD' }
  if (!trackNames.length) return { success:false, error:'请至少填写一首曲目' }

  const existing = await db.collection('album_candidates').where({ title, artist, status:'pending' }).limit(1).get()
  if (existing.data.length) return { success:true, existed:true, status:'pending', albumTitle:title }

  const sourceId = `manual_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
  const releaseYear = releaseDate ? Number(releaseDate.slice(0,4)) : 0
  const tracks = trackNames.map((name, index) => ({ no:index + 1, name, artistText:artist, artists:[] }))
  await db.collection('album_candidates').add({ data:{
    sourceId,
    submissionMode:'manual',
    manualSubmission:true,
    title,
    artist,
    primaryArtist:artist.split(/[\/，,、&]/)[0].trim(),
    neteaseArtistId:artistIds[0] || '',
    artistIds,
    releaseDate,
    releaseYear,
    coverUrl,
    company,
    description,
    tracks,
    trackCount:tracks.length,
    avgScore:0,
    reviewCount:0,
    genres:[],
    status:'pending',
    reportReason:'用户手动提交下架或网易云无法检索的专辑',
    reportSource:'discover-submit-manual',
    requestSource:'discover-submit-manual',
    requesterOpenId:openId,
    requestedName:title,
    foundFrom:'用户手动提交',
    addedAt:db.serverDate(),
    decidedAt:null,
  } })
  return { success:true, existed:false, albumTitle:title, sourceId, submissionMode:'manual' }
}

async function findDuplicate(sourceId) {
  const [existingAlbum, existingCandidate] = await Promise.all([
    db.collection('albums').where({ sourceId }).limit(1).get(),
    db.collection('album_candidates').where({ sourceId }).limit(1).get(),
  ])
  if (existingAlbum.data.length) return { success:true, existed:true, status:'approved', albumTitle:existingAlbum.data[0].title || '' }
  if (existingCandidate.data.length) return { success:true, existed:true, status:existingCandidate.data[0].status || 'pending', albumTitle:existingCandidate.data[0].title || '' }
  return null
}

function normalize(value){ return String(value || '').trim().toLowerCase().replace(/\s+/g,'') }
function getJson(url){return new Promise((resolve,reject)=>{const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://music.163.com/'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{resolve(JSON.parse(body))}catch(e){resolve(null)}})});req.on('error',reject);req.setTimeout(10000,()=>{req.destroy();reject(new Error('网易云请求超时'))})})}
