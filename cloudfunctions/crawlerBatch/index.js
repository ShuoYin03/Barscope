const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const STATUS_COLLECTION = 'crawlerStatus'
const STATUS_ID = 'singleton'
const BATCH_SIZE = 10
const SKIP_KEYWORDS = ['第一期','第二期','第三期','第四期','第五期','第六期','第七期','第八期','第九期','第十期','精选集','合辑','现场版','Live','OST','原声','巅峰对决','新说唱','中国有嘻哈','说唱新世代']

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!(await isAdmin(OPENID))) return { success: false, error: '无权限' }
  const cursor = Math.max(0, Number(event.cursor || 0))
  const initialize = !!event.initialize || cursor === 0
  const approved = await db.collection('artist_candidates').where({ status: 'approved' }).field({ _id: true, artistId: true, artistName: true }).limit(1000).get()
  const list = (approved.data || []).filter(x => x.artistId)
  const total = list.length
  if (!total) return { success: true, status: 'done', nextCursor: null }
  let status = await getStatus()
  if (initialize) {
    status = { ...status, status: 'running', mode: 'allApproved', param: '', abort: false, triggeredAt: db.serverDate(), completedAt: null, progress: { totalArtists: total, processedArtists: 0, albumsFound: 0, candidatesFound: 0 }, lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [] }, log: [`云端分批任务已开始：每批 ${BATCH_SIZE} 位 rapper`] }
    await saveStatus(status)
  }
  status = await getStatus()
  if (status.abort) { await markAborted(status, total); return { success: true, status: 'aborted', nextCursor: null } }
  const slice = list.slice(cursor, cursor + BATCH_SIZE)
  for (const artist of slice) {
    const latest = await getStatus()
    if (latest.abort) { await markAborted(latest, total); return { success: true, status: 'aborted', nextCursor: null } }
    let result = { inserted: 0, candidates: 0 }, err = ''
    try { result = await syncArtist(String(artist.artistId), artist.artistName || '') } catch (e) { err = e.message }
    const current = await getStatus(), p = current.progress || {}, processed = Number(p.processedArtists || cursor) + 1
    current.status = 'running'
    current.progress = { totalArtists: total, processedArtists: processed, albumsFound: Number(p.albumsFound || 0) + result.inserted, candidatesFound: Number(p.candidatesFound || 0) + result.candidates }
    current.log = prependLog(current.log, err ? `[${processed}/${total}] ${artist.artistName || artist.artistId} 失败：${err}` : `[${processed}/${total}] ${artist.artistName || artist.artistId}：新增${result.inserted}张，候选${result.candidates}张`)
    await saveStatus(current)
  }
  const after = await getStatus()
  if (after.abort) { await markAborted(after, total); return { success: true, status: 'aborted', nextCursor: null } }
  const nextCursor = cursor + slice.length
  if (nextCursor >= total) {
    const p = after.progress || {}
    after.status = 'done'; after.abort = false; after.completedAt = db.serverDate()
    after.lastRunSummary = { newAlbums: Number(p.albumsFound || 0), newCandidates: Number(p.candidatesFound || 0), errors: [] }
    after.log = prependLog(after.log, `云端分批任务完成：新增${Number(p.albumsFound || 0)}张，候选${Number(p.candidatesFound || 0)}张`)
    await saveStatus(after)
    return { success: true, status: 'done', nextCursor: null }
  }
  return { success: true, status: 'running', nextCursor }
}

async function syncArtist(artistId, fallbackName) {
  const rawAlbums = await fetchArtistAlbums(artistId)
  let inserted = 0, candidates = 0
  for (const raw of rawAlbums) {
    const album = normalizeAlbum(raw, fallbackName)
    if (!album) continue
    const existing = await db.collection('albums').where({ sourceId: album.sourceId }).limit(1).get()
    if (existing.data.length) {
      const old = existing.data[0], oldIds = Array.isArray(old.collaboratorArtistIds) ? old.collaboratorArtistIds : [], patch = {}
      if (!sameIds(oldIds, album.collaboratorArtistIds)) patch.collaboratorArtistIds = album.collaboratorArtistIds
      if (!old.neteaseArtistId && album.neteaseArtistId) patch.neteaseArtistId = album.neteaseArtistId
      if (!old.releaseDate && album.releaseDate) { patch.releaseDate = album.releaseDate; patch.releaseYear = album.releaseYear }
      if (Object.keys(patch).length) await db.collection('albums').doc(old._id).update({ data: patch })
      continue
    }
    const detail = await fetchAlbumDetail(album.sourceId)
    if (isLowQuality(detail && detail.songs)) {
      const candidate = await db.collection('album_candidates').where({ sourceId: album.sourceId }).limit(1).get()
      if (!candidate.data.length) { await db.collection('album_candidates').add({ data: { ...album, approved: false, status: 'pending', crawlSource: 'cloud-initial-quality-filter', addedAt: db.serverDate() } }); candidates += 1 }
      continue
    }
    await db.collection('albums').add({ data: { ...album, approved: true } }); inserted += 1
  }
  return { inserted, candidates }
}
function normalizeAlbum(raw, fallbackName) { const title=String(raw.name||'').trim(), rawArtists=raw.artists||(raw.artist?[raw.artist]:[]), names=rawArtists.map(x=>String(x.name||'').trim()).filter(Boolean), ids=[...new Set(rawArtists.map(x=>String(x.id||'')).filter(Boolean))], primaryArtist=String((raw.artist||{}).name||fallbackName||names[0]||'').trim(), sourceId=String(raw.id||''), releaseDate=dateFromTimestamp(raw.publishTime), releaseYear=releaseDate?Number(releaseDate.slice(0,4)):0, trackCount=Number(raw.size||0); if(!title||!sourceId||!primaryArtist||!releaseDate||trackCount<3)return null; if(releaseYear<1990||releaseYear>new Date().getFullYear()+1)return null; if(SKIP_KEYWORDS.some(k=>title.includes(k)))return null; return {title,artist:names.length>1?names.join(' / '):primaryArtist,primaryArtist,neteaseArtistId:String((raw.artist||{}).id||ids[0]||''),collaboratorArtistIds:ids,sourceId,coverUrl:raw.picUrl||raw.blurPicUrl||'',releaseYear,releaseDate,genres:[],source:'netease',crawlSource:'cloud-batch',avgScore:0,reviewCount:0,trackCount} }
function isLowQuality(songs) { const names=(songs||[]).map(x=>String(x.name||'').trim()).filter(Boolean); if(names.some(n=>/(伴奏|instrumental|inst\.?|off\s*vocal|karaoke|纯音乐|伴奏版|伴奏带)/i.test(n)))return true; const normalized=names.map(n=>n.replace(/[（(【\[][^）)】\]]*[）)】\]]/g,'').replace(/(伴奏|instrumental|inst\.?|off\s*vocal|karaoke|纯音乐|伴奏版|伴奏带)/ig,'').replace(/[\s\-_.·]/g,'').toLowerCase()).filter(Boolean); return normalized.length>=2&&new Set(normalized).size===1 }
function dateFromTimestamp(value){const d=new Date(Number(value||0));if(Number.isNaN(d.getTime()))return '';return`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`}
function sameIds(a,b){return JSON.stringify((a||[]).slice().sort())===JSON.stringify((b||[]).slice().sort())}
async function fetchArtistAlbums(id){const albums=[];let offset=0;while(true){const data=await request(`https://music.163.com/api/artist/albums/${id}?limit=50&offset=${offset}`);if(!data||data.code!==200)break;const batch=data.hotAlbums||[];albums.push(...batch);if(!data.more||!batch.length)break;offset+=50}return albums}
async function fetchAlbumDetail(id){const data=await request(`https://music.163.com/api/v1/album/${id}`);return data&&data.code===200?data:null}
function request(url){return new Promise((resolve,reject)=>{const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://music.163.com/'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{resolve(JSON.parse(body))}catch(e){resolve(null)}})});req.on('error',reject);req.setTimeout(10000,()=>{req.destroy();reject(new Error('timeout'))})})}
async function isAdmin(openId){if(!openId)return false;const r=await db.collection('users').where({openId,type:'admin'}).limit(1).get();return r.data.length>0}
async function getStatus(){try{return(await db.collection(STATUS_COLLECTION).doc(STATUS_ID).get()).data}catch(e){return{status:'idle',abort:false,progress:{},log:[]}}}
async function saveStatus(status){const log=Array.isArray(status.log)?status.log:[];await db.collection(STATUS_COLLECTION).doc(STATUS_ID).set({data:{...status,log,logs:log}})}
function prependLog(log,text){return[text,...(Array.isArray(log)?log:[])].slice(0,100)}
async function markAborted(status,total){const p=status.progress||{};status.status='aborted';status.abort=false;status.completedAt=db.serverDate();status.progress={totalArtists:total,processedArtists:Number(p.processedArtists||0),albumsFound:Number(p.albumsFound||0),candidatesFound:Number(p.candidatesFound||0)};status.lastRunSummary={newAlbums:status.progress.albumsFound,newCandidates:status.progress.candidatesFound,errors:['用户中止']};status.log=prependLog(status.log,'任务已中止；已写入的数据会保留');await saveStatus(status)}
