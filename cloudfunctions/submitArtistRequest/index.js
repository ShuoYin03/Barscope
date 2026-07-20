const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// Deterministic negative id for manual (no NetEase match) submissions — never collides with a
// real NetEase artistId (always positive), and hashing the name means resubmitting the same
// name twice naturally lands on the same synthetic id instead of creating duplicates.
function hashString(str) {
  let hash = 5381
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  return hash
}

async function submitManual(keyword, OPENID) {
  const manualId = -Math.abs(hashString(keyword.toLowerCase().replace(/\s/g, ''))) || -Date.now()
  const exists = await db.collection('artist_candidates').where({ artistId: manualId }).limit(1).get()
  if (exists.data.length) {
    const current = exists.data[0]
    return { success: true, existed: true, status: current.status, artistName: current.artistName || keyword }
  }
  await db.collection('artist_candidates').add({ data: {
    artistId: manualId,
    artistName: keyword,
    picUrl: '', avatarUrl: '', coverUrl: '', backgroundUrl: '', heroImageUrl: '',
    albumSize: 0, musicSize: 0, fansSize: 0,
    roles: ['rapper'],
    foundFrom: '用户提交',
    fromAlbum: '',
    round: 999,
    status: 'pending',
    requestSource: 'profile-submit-manual',
    requesterOpenId: OPENID,
    requestedName: keyword,
    manualEntry: true,
    addedAt: db.serverDate(),
    decidedAt: null,
  } })
  return { success: true, existed: false, artistName: keyword, artistId: manualId, manualEntry: true }
}

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  const keyword = String(event.name || '').trim()
  const manual = !!event.manual
  if (!OPENID) return { success:false, error:'请先登录' }
  if (keyword.length < 1 || keyword.length > 50) return { success:false, error:'请输入有效的 rapper 名称' }
  try {
    // Explicit manual submission — the caller already confirmed after a failed NetEase search,
    // so skip straight to creating a source-less candidate for admin review.
    if (manual) return await submitManual(keyword, OPENID)

    const search = await getJson(`https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(keyword)}&type=100&offset=0&total=true&limit=10`)
    const artists = (search && search.result && search.result.artists) || []
    if (!artists.length) {
      // No NetEase presence at all — let the caller offer a manual submission instead of just
      // failing outright (a real rapper who's QQ-only, too new, or otherwise not on NetEase
      // shouldn't be unsubmittable).
      return { success:true, needsManual:true, searchedName:keyword }
    }
    const normalized = keyword.toLowerCase().replace(/\s/g,'')
    const picked = artists.find(a => String(a.name||'').toLowerCase().replace(/\s/g,'') === normalized) || artists[0]
    const artistId = Number(picked.id || 0)
    if (!artistId) return { success:false, error:'网易云艺人信息无效' }

    const exists = await db.collection('artist_candidates').where({ artistId }).limit(1).get()
    if (exists.data.length) {
      const current = exists.data[0]
      return { success:true, existed:true, status:current.status, artistName:current.artistName || picked.name }
    }

    const avatar = picked.picUrl || picked.img1v1Url || ''
    await db.collection('artist_candidates').add({ data:{
      artistId,
      artistName:String(picked.name || keyword),
      picUrl:avatar,
      avatarUrl:avatar,
      coverUrl:'',
      backgroundUrl:'',
      heroImageUrl:'',
      albumSize:Number(picked.albumSize || 0),
      musicSize:Number(picked.musicSize || 0),
      fansSize:0,
      roles:['rapper'],
      foundFrom:'用户提交',
      fromAlbum:'',
      round:999,
      status:'pending',
      requestSource:'profile-submit',
      requesterOpenId:OPENID,
      requestedName:keyword,
      addedAt:db.serverDate(),
      decidedAt:null,
    } })
    return { success:true, existed:false, artistName:String(picked.name || keyword), artistId }
  } catch (e) { return { success:false, error:e.message } }
}
function getJson(url){return new Promise((resolve,reject)=>{const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://music.163.com/'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{resolve(JSON.parse(body))}catch(e){resolve(null)}})});req.on('error',reject);req.setTimeout(10000,()=>{req.destroy();reject(new Error('网易云请求超时'))})})}
