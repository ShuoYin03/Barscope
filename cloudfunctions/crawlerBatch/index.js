const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const C = 'crawlerStatus'
const D = 'singleton'
const ALBUMS_PER_STEP = 16
const SKIP = ['第一期','第二期','第三期','第四期','第五期','第六期','第七期','第八期','第九期','第十期','精选集','合辑','现场版','Live','OST','原声','巅峰对决','新说唱','中国有嘻哈','说唱新世代']

exports.main = async e => {
  const { OPENID } = cloud.getWXContext()
  if (!(await admin(OPENID))) return { success:false, error:'无权限' }
  let s = await get()
  if (e.initialize) {
    const r = await db.collection('artist_candidates').where({ status:'approved' }).field({ artistId:true, artistName:true }).limit(1000).get()
    const artists = (r.data || []).filter(x => x.artistId)
    s = { status:'running', mode:'allApproved', param:'', abort:false,
      queue:{ artists, artistIndex:0, albumIndex:0, currentArtistId:'', currentAlbums:[] },
      progress:{ totalArtists:artists.length, processedArtists:0, albumsFound:0, candidatesFound:0 },
      lastRunSummary:{ newAlbums:0, newCandidates:0, errors:[] },
      log:[`任务开始：${artists.length} 位艺人；每批最多处理 ${ALBUMS_PER_STEP} 张专辑，归属以网易云专辑详情页艺人栏为准`],
      triggeredAt:db.serverDate(), completedAt:null }
    await save(s, true)
    return { success:true, status:'running', next:true }
  }
  if (s.abort) return await abort(s)
  if (s.status !== 'running' || !s.queue) return { success:false, error:'没有可继续的任务' }
  const q = s.queue
  const artists = q.artists || []
  if (q.artistIndex >= artists.length) {
    s.status = 'done'; s.completedAt = db.serverDate()
    s.lastRunSummary = { newAlbums:+s.progress.albumsFound || 0, newCandidates:+s.progress.candidatesFound || 0, errors:[] }
    s.log = log(s.log, '任务完成')
    await save(s)
    return { success:true, status:'done', next:false }
  }
  const artist = artists[q.artistIndex]
  if (q.currentArtistId !== String(artist.artistId) || !Array.isArray(q.currentAlbums)) {
    let raw = []
    try { raw = await fetchAlbums(String(artist.artistId)) } catch (err) {}
    q.currentArtistId = String(artist.artistId)
    q.currentAlbums = raw.map(x => seedAlbum(x, artist.artistName || '')).filter(Boolean)
    q.albumIndex = 0
    s.log = log(s.log, `[${q.artistIndex + 1}/${artists.length}] ${artist.artistName || artist.artistId}：载入 ${q.currentAlbums.length} 张专辑`)
  }
  const albums = q.currentAlbums || []
  if (q.albumIndex >= albums.length) {
    q.artistIndex++; q.albumIndex = 0; q.currentArtistId = ''; q.currentAlbums = []
    s.progress.processedArtists = q.artistIndex
    s.log = log(s.log, `[${q.artistIndex}/${artists.length}] ${artist.artistName || artist.artistId} 完成`)
    await save(s)
    return { success:true, status:'running', next:true }
  }
  const batch = albums.slice(q.albumIndex, q.albumIndex + ALBUMS_PER_STEP)
  const results = await Promise.all(batch.map(processAlbum))
  results.forEach(r => {
    if (r.newAlbum) s.progress.albumsFound = (+s.progress.albumsFound || 0) + 1
    if (r.candidate) s.progress.candidatesFound = (+s.progress.candidatesFound || 0) + 1
    s.log = log(s.log, `[${q.artistIndex + 1}/${artists.length}] ${artist.artistName || artist.artistId} · ${r.title}：${r.out}`)
  })
  q.albumIndex += batch.length
  const latest = await get()
  if (latest.abort) { s.abort = true; return await abort(s) }
  await save(s)
  return { success:true, status:'running', next:true, processed:batch.length }
}

function seedAlbum(x, fallback) {
  const title = String(x.name || '').trim()
  const sourceId = String(x.id || '')
  const releaseDate = date(x.publishTime)
  const releaseYear = releaseDate ? +releaseDate.slice(0, 4) : 0
  const trackCount = +x.size || 0
  const primaryArtist = String((x.artist || {}).name || fallback || '').trim()
  if (!title || !sourceId || !primaryArtist || !releaseDate || trackCount < 3 || releaseYear < 1990 || releaseYear > new Date().getFullYear() + 1 || SKIP.some(k => title.includes(k))) return null
  return { title, sourceId, coverUrl:x.picUrl || x.blurPicUrl || '', releaseDate, releaseYear, trackCount, fallbackArtist:primaryArtist }
}

async function processAlbum(seed) {
  let out = '已存在', newAlbum = false, candidate = false
  try {
    const detail = await fetchDetail(seed.sourceId)
    const album = normalizeDetailAlbum(seed, detail && detail.album)
    if (!album) return { title:seed.title, out:'详情缺失', newAlbum:false, candidate:false }
    const ex = await db.collection('albums').where({ sourceId:album.sourceId }).limit(1).get()
    if (ex.data.length) {
      const old = ex.data[0]
      const patch = {}
      if (old.artist !== album.artist) patch.artist = album.artist
      if (old.primaryArtist !== album.primaryArtist) patch.primaryArtist = album.primaryArtist
      if (String(old.neteaseArtistId || '') !== String(album.neteaseArtistId || '')) patch.neteaseArtistId = album.neteaseArtistId
      if (!sameArray(old.collaboratorArtistIds, album.collaboratorArtistIds)) patch.collaboratorArtistIds = album.collaboratorArtistIds
      if (!sameArray(old.collaboratorArtistNames, album.collaboratorArtistNames)) patch.collaboratorArtistNames = album.collaboratorArtistNames
      if (!sameArtistList(old.collaboratorArtists, album.collaboratorArtists)) patch.collaboratorArtists = album.collaboratorArtists
      if (!old.releaseDate && album.releaseDate) { patch.releaseDate = album.releaseDate; patch.releaseYear = album.releaseYear }
      if (Object.keys(patch).length) { await db.collection('albums').doc(old._id).update({ data:patch }); out = '校正归属' }
    } else {
      const verdict = bad(detail && detail.songs)
      if (verdict.bad) {
        const c = await db.collection('album_candidates').where({ sourceId:album.sourceId }).limit(1).get()
        if (!c.data.length) {
          await db.collection('album_candidates').add({ data:{ ...album, approved:false, status:'pending', crawlSource:'cloud-initial-quality-filter', candidateReason:verdict.reason, duplicateTrackExample:verdict.example, addedAt:db.serverDate() } })
          candidate = true; out = '候选'
        }
      } else {
        await db.collection('albums').add({ data:{ ...album, approved:true } })
        newAlbum = true; out = '新增'
      }
    }
  } catch (err) { out = '失败' }
  return { title:seed.title, out, newAlbum, candidate }
}

function normalizeDetailAlbum(seed, raw) {
  if (!raw) return null
  const official = Array.isArray(raw.artists) && raw.artists.length ? raw.artists : (raw.artist ? [raw.artist] : [])
  const collaboratorArtists = official.map(a => ({ id:String(a && a.id || ''), name:String(a && a.name || '').trim() })).filter(a => a.id || a.name)
  const collaboratorArtistIds = [...new Set(collaboratorArtists.map(a => a.id).filter(Boolean))]
  const collaboratorArtistNames = [...new Set(collaboratorArtists.map(a => a.name).filter(Boolean))]
  const primaryArtist = String((raw.artist || {}).name || collaboratorArtistNames[0] || seed.fallbackArtist || '').trim()
  const neteaseArtistId = String((raw.artist || {}).id || collaboratorArtistIds[0] || '')
  if (!primaryArtist) return null
  if (neteaseArtistId && !collaboratorArtistIds.includes(neteaseArtistId)) collaboratorArtistIds.unshift(neteaseArtistId)
  if (primaryArtist && !collaboratorArtistNames.includes(primaryArtist)) collaboratorArtistNames.unshift(primaryArtist)
  return { title:String(raw.name || seed.title || '').trim(), artist:collaboratorArtistNames.join(' / '), primaryArtist, neteaseArtistId, collaboratorArtists, collaboratorArtistIds, collaboratorArtistNames, sourceId:seed.sourceId, coverUrl:raw.picUrl || raw.blurPicUrl || seed.coverUrl || '', releaseYear:seed.releaseYear, releaseDate:seed.releaseDate, genres:[], source:'netease', crawlSource:'cloud-step', avgScore:0, reviewCount:0, trackCount:Number(raw.size || seed.trackCount || 0) }
}

function sameArray(a, b) { return JSON.stringify(Array.isArray(a) ? a : []) === JSON.stringify(Array.isArray(b) ? b : []) }
function sameArtistList(a, b) { return JSON.stringify((Array.isArray(a) ? a : []).map(x => ({ id:String(x.id || ''), name:String(x.name || '') }))) === JSON.stringify((Array.isArray(b) ? b : []).map(x => ({ id:String(x.id || ''), name:String(x.name || '') }))) }
async function abort(s) { s.status = 'aborted'; s.abort = false; s.completedAt = db.serverDate(); s.lastRunSummary = { newAlbums:+s.progress.albumsFound || 0, newCandidates:+s.progress.candidatesFound || 0, errors:['用户中止'] }; s.log = log(s.log, '任务已中止'); await save(s); return { success:true, status:'aborted', next:false } }
function bad(s) { const names=(s||[]).map(x=>String(x.name||'').trim()).filter(Boolean), re=/(伴奏|instrumental|inst\.?|off\s*vocal|karaoke|纯音乐|伴奏版|伴奏带)/i; if(names.some(x=>re.test(x))) return { bad:true, reason:'含有伴奏/纯音乐版本曲目', example:names.filter(x=>re.test(x)).slice(0,4) }; const normalized=names.map(x=>x.replace(/[（(【\[][^）)】\]]*[）)】\]]/g,'').replace(re,'').replace(/[\s\-_.·]/g,'').toLowerCase()).filter(Boolean); return normalized.length>=2&&new Set(normalized).size===1 ? { bad:true, reason:'全专曲目名称重复', example:names.slice(0,4) } : { bad:false } }
function date(v) { const d=new Date(+v || 0); return Number.isNaN(d.getTime()) ? '' : `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}` }
function req(url) { return new Promise((resolve,reject)=>{ const r=https.get(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://music.163.com/'}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>{try{resolve(JSON.parse(body))}catch(e){resolve(null)}})});r.on('error',reject);r.setTimeout(7000,()=>{r.destroy();reject(new Error('timeout'))}) }) }
async function fetchAlbums(id) { const all=[]; let offset=0; while(true){const x=await req(`https://music.163.com/api/artist/albums/${id}?limit=50&offset=${offset}`);if(!x||x.code!==200)break;const batch=x.hotAlbums||[];all.push(...batch);if(!x.more||!batch.length)break;offset+=50} return all }
async function fetchDetail(id) { const x=await req(`https://music.163.com/api/v1/album/${id}`); return x&&x.code===200 ? x : null }
async function admin(id) { if(!id)return false; const r=await db.collection('users').where({openId:id,type:'admin'}).limit(1).get();return !!r.data.length }
async function get() { try{return (await db.collection(C).doc(D).get()).data}catch(e){return { status:'idle',log:[],progress:{} }} }
async function save(s, allowRestart=false) { let current={};try{current=(await db.collection(C).doc(D).get()).data||{}}catch(e){}; if(!allowRestart && current.status==='aborted' && s.status==='running') return; const n={...s};delete n._id;n.log=Array.isArray(n.log)?n.log:[];n.logs=n.log;if(current.abort===true&&n.status==='running')n.abort=true;await db.collection(C).doc(D).set({data:n}) }
function log(items,text) { return [text,...(Array.isArray(items)?items:[])].slice(0,100) }
