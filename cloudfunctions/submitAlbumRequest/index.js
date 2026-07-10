const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  const keyword = String(event.name || '').trim()
  if (!OPENID) return { success:false, error:'请先登录' }
  if (keyword.length < 1 || keyword.length > 80) return { success:false, error:'请输入有效的专辑名称' }

  try {
    const search = await getJson(`https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(keyword)}&type=10&offset=0&total=true&limit=10`)
    const albums = (search && search.result && search.result.albums) || []
    if (!albums.length) return { success:false, error:'未找到对应网易云专辑' }

    const normalized = normalize(keyword)
    const picked = albums.find(a => normalize(a.name) === normalized) || albums[0]
    const sourceId = String(picked.id || '')
    if (!sourceId) return { success:false, error:'网易云专辑信息无效' }

    const [existingAlbum, existingCandidate] = await Promise.all([
      db.collection('albums').where({ sourceId }).limit(1).get(),
      db.collection('album_candidates').where({ sourceId }).limit(1).get(),
    ])
    if (existingAlbum.data.length) return { success:true, existed:true, status:'approved', albumTitle:existingAlbum.data[0].title || picked.name }
    if (existingCandidate.data.length) return { success:true, existed:true, status:existingCandidate.data[0].status || 'pending', albumTitle:existingCandidate.data[0].title || picked.name }

    const artists = Array.isArray(picked.artists) ? picked.artists : []
    const artistNames = artists.map(a => a && a.name).filter(Boolean)
    const artistIds = artists.map(a => String(a && a.id || '')).filter(Boolean)
    const publishTime = Number(picked.publishTime || 0)
    const published = publishTime ? new Date(publishTime) : null
    const releaseDate = published ? `${published.getUTCFullYear()}-${String(published.getUTCMonth()+1).padStart(2,'0')}-${String(published.getUTCDate()).padStart(2,'0')}` : ''
    const releaseYear = published ? published.getUTCFullYear() : 0

    await db.collection('album_candidates').add({ data:{
      sourceId,
      title:String(picked.name || keyword),
      artist:artistNames.join(' / '),
      primaryArtist:artistNames[0] || '',
      neteaseArtistId:artistIds[0] || '',
      artistIds,
      releaseDate,
      releaseYear,
      coverUrl:String(picked.picUrl || picked.blurPicUrl || ''),
      company:String(picked.company || ''),
      avgScore:0,
      reviewCount:0,
      genres:[],
      status:'pending',
      reportReason:'用户提交新专辑',
      reportSource:'discover-submit',
      requestSource:'discover-submit',
      requesterOpenId:OPENID,
      requestedName:keyword,
      foundFrom:'用户提交',
      addedAt:db.serverDate(),
      decidedAt:null,
    } })

    return { success:true, existed:false, albumTitle:String(picked.name || keyword), sourceId }
  } catch (e) {
    console.error('submitAlbumRequest failed:', e)
    return { success:false, error:e.message }
  }
}

function normalize(value){ return String(value || '').trim().toLowerCase().replace(/\s+/g,'') }
function getJson(url){return new Promise((resolve,reject)=>{const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://music.163.com/'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{resolve(JSON.parse(body))}catch(e){resolve(null)}})});req.on('error',reject);req.setTimeout(10000,()=>{req.destroy();reject(new Error('网易云请求超时'))})})}
