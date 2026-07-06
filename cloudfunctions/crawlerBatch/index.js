const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const C = 'crawlerStatus'
const D = 'singleton'
const ALBUMS_PER_STEP = 8
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
      log:[`任务开始：${artists.length} 位艺人；每步最多处理 ${ALBUMS_PER_STEP} 张专辑`],
      triggeredAt:db.serverDate(), completedAt:null }
    await save(s)
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
  // Cache the normalized album list in the run state: no repeated Netease fetch for every album.
  if (q.currentArtistId !== String(artist.artistId) || !Array.isArray(q.currentAlbums)) {
    let raw = []
    try { raw = await fetchAlbums(String(artist.artistId)) } catch (err) {}
    q.currentArtistId = String(artist.artistId)
    q.currentAlbums = raw.map(x => norm(x, artist.artistName || '')).filter(Boolean)
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
  const results = await Promise.all(batch.map(album => processAlbum(album)))
  results.forEach(r => {
    if (r.newAlbum) s.progress.albumsFound = (+s.progress.albumsFound || 0) + 1
    if (r.candidate) s.progress.candidatesFound = (+s.progress.candidatesFound || 0) + 1
    s.log = log(s.log, `[${q.artistIndex + 1}/${artists.length}] ${artist.artistName || artist.artistId} · ${r.title}：${r.out}`)
  })
  q.albumIndex += batch.length

  // A stop request may have arrived while this batch was running.
  const latest = await get()
  if (latest.abort) {
    s.abort = true
    return await abort(s)
  }
  await save(s)
  return { success:true, status:'running', next:true, processed:batch.length }
}

async function processAlbum(album) {
  let out = '已存在', newAlbum = false, candidate = false
  try {
    const ex = await db.collection('albums').where({ sourceId:album.sourceId }).limit(1).get()
    if (ex.data.length) {
      const old = ex.data[0], patch = {}
      const oldIds = Array.isArray(old.collaboratorArtistIds) ? old.collaboratorArtistIds : []
      if (JSON.stringify(oldIds.slice().sort()) !== JSON.stringify(album.collaboratorArtistIds.slice().sort())) patch.collaboratorArtistIds = album.collaboratorArtistIds
      if (album.collaboratorArtists?.length) patch.collaboratorArtists = album.collaboratorArtists
      if (album.collaboratorArtistNames?.length) patch.collaboratorArtistNames = album.collaboratorArtistNames
      if (!old.releaseDate && album.releaseDate) { patch.releaseDate = album.releaseDate; patch.releaseYear = album.releaseYear }
      if (Object.keys(patch).length) await db.collection('albums').doc(old._id).update({ data:patch })
    } else {
      const detail = await fetchDetail(album.sourceId)
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
  return { title:album.title, out, newAlbum, candidate }
}

async function abort(s) {
  s.status = 'aborted'; s.abort = false; s.completedAt = db.serverDate()
  s.lastRunSummary = { newAlbums:+s.progress.albumsFound || 0, newCandidates:+s.progress.candidatesFound || 0, errors:['用户中止'] }
  s.log = log(s.log, '任务已中止')
  await save(s)
  return { success:true, status:'aborted', next:false }
}

function norm(x,f) {
  const title = String(x.name || '').trim()
  const rawArtists = x.artists || (x.artist ? [x.artist] : [])
  const collaboratorArtists = rawArtists.map(a => ({ id:String(a.id || ''), name:String(a.name || '').trim() })).filter(a => a.id || a.name)
  const collaboratorArtistIds = [...new Set(collaboratorArtists.map(a => a.id).filter(Boolean))]
  const collaboratorArtistNames = [...new Set(collaboratorArtists.map(a => a.name).filter(Boolean))]
  const primaryArtist = String((x.artist || {}).name || f || collaboratorArtistNames[0] || '').trim()
  const neteaseArtistId = String((x.artist || {}).id || collaboratorArtistIds[0] || '')
  if (neteaseArtistId && !collaboratorArtistIds.includes(neteaseArtistId)) collaboratorArtistIds.unshift(neteaseArtistId)
  if (primaryArtist && !collaboratorArtistNames.includes(primaryArtist)) collaboratorArtistNames.unshift(primaryArtist)
  const sourceId = String(x.id || ''), releaseDate = date(x.publishTime), releaseYear = releaseDate ? +releaseDate.slice(0,4) : 0, trackCount = +x.size || 0
  if (!title || !sourceId || !primaryArtist || !releaseDate || trackCount < 3 || releaseYear < 1990 || releaseYear > new Date().getFullYear()+1 || SKIP.some(k => title.includes(k))) return null
  return { title, artist:collaboratorArtistNames.length > 1 ? collaboratorArtistNames.join(' / ') : primaryArtist, primaryArtist, neteaseArtistId, collaboratorArtists, collaboratorArtistIds, collaboratorArtistNames, sourceId, coverUrl:x.picUrl || x.blurPicUrl || '', releaseYear, releaseDate, genres:[], source:'netease', crawlSource:'cloud-step', avgScore:0, reviewCount:0, trackCount }
}
function bad(s) { const names=(s||[]).map(x=>String(x.name||'').trim()).filter(Boolean), re=/(伴奏|instrumental|inst\.?|off\s*vocal|karaoke|纯音乐|伴奏版|伴奏带)/i; if(names.some(x=>re.test(x))) return { bad:true, reason:'含有伴奏/纯音乐版本曲目', example:names.filter(x=>re.test(x)).slice(0,4) }; const normalized=names.map(x=>x.replace(/[（(【\[][^）)】\]]*[）)】\]]/g,'').replace(re,'').replace(/[\s\-_.·]/g,'').toLowerCase()).filter(Boolean); return normalized.length>=2&&new Set(normalized).size===1 ? { bad:true, reason:'全专曲目名称重复', example:names.slice(0,4) } : { bad:false } }
function date(v) { const d=new Date(+v || 0); return Number.isNaN(d.getTime()) ? '' : `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}` }
function req(url) { return new Promise((resolve,reject)=>{ const r=https.get(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://music.163.com/'}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>{try{resolve(JSON.parse(body))}catch(e){resolve(null)}})});r.on('error',reject);r.setTimeout(7000,()=>{r.destroy();reject(new Error('timeout'))}) }) }
async function fetchAlbums(id) { const all=[]; let offset=0; while(true){const x=await req(`https://music.163.com/api/artist/albums/${id}?limit=50&offset=${offset}`);if(!x||x.code!==200)break;const batch=x.hotAlbums||[];all.push(...batch);if(!x.more||!batch.length)break;offset+=50} return all }
async function fetchDetail(id) { const x=await req(`https://music.163.com/api/v1/album/${id}`); return x&&x.code===200 ? x : null }
async function admin(id) { if(!id)return false; const r=await db.collection('users').where({openId:id,type:'admin'}).limit(1).get();return !!r.data.length }
async function get() { try{return (await db.collection(C).doc(D).get()).data}catch(e){return { status:'idle',log:[],progress:{} }} }
async function save(s) { let current={};try{current=(await db.collection(C).doc(D).get()).data||{}}catch(e){}; if(current.status==='aborted' && s.status==='running') return; const n={...s};delete n._id;n.log=Array.isArray(n.log)?n.log:[];n.logs=n.log;if(current.abort===true&&n.status==='running')n.abort=true;await db.collection(C).doc(D).set({data:n}) }
function log(items,text) { return [text,...(Array.isArray(items)?items:[])].slice(0,100) }
