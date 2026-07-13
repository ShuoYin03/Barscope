const cloud = require('wx-server-sdk')
const https = require('https')
const { resolveOwners, isGuest, featureIds } = require('./ownership')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  const albumDocId = event.albumId || event.id
  const sourceId = event.sourceId
  if (!albumDocId && !sourceId) return { success:false, error:'missing albumId or sourceId' }
  try {
    let albumDoc
    if (albumDocId) albumDoc = (await db.collection('albums').doc(albumDocId).get()).data
    else albumDoc = (await db.collection('albums').where({ sourceId:String(sourceId) }).limit(1).get()).data[0]
    if (!albumDoc) return { success:false, error:'album not found' }
    const neteaseAlbumId = String(sourceId || albumDoc.sourceId || '')
    const detail = await fetchAlbumDetail(neteaseAlbumId)
    if (!detail) return { success:false, error:'netease album api failed' }
    const album = detail.album || detail.data?.album || {}
    const songs = detail.songs || detail.data?.songs || album.songs || []
    const albumArtists = (Array.isArray(album.artists) && album.artists.length) ? album.artists : (album.artist ? [album.artist] : [])
    const neArtistNames = [...new Set(albumArtists.map(a => String(a && a.name || '').trim()).filter(Boolean))]
    const neArtistIds = [...new Set(albumArtists.map(a => String(a && a.id || '')).filter(Boolean))]
    // Owner set drives Feat classification: pinned for corrected albums, else NetEase album-level artists.
    const { ownerIds, ownerNames } = resolveOwners(albumDoc, albumArtists)
    const primaryArtist = String((album.artist || {}).name || neArtistNames[0] || albumDoc.primaryArtist || '').trim()
    const neteaseArtistId = String((album.artist || {}).id || neArtistIds[0] || albumDoc.neteaseArtistId || '')
    const artistDisplay = neArtistNames.join(' / ') || primaryArtist
    const tracks = songs.map((song, idx) => normalizeTrack(song, idx, ownerIds, ownerNames))
    const featuringGuests = collectGuests(tracks)
    const patch = { description:extractDescription(detail, album, albumDoc), company:album.company || albumDoc.company || '', trackCount:tracks.length || album.size || albumDoc.trackCount || 0, tracks, featuringGuests, trackSyncedAt:db.serverDate() }
    // Preserve manual ownership corrections: never let a NetEase re-sync overwrite artist attribution
    // that an admin deliberately fixed. Track/description/company backfill still proceeds.
    if (albumDoc.ownershipSource !== 'user-admin-correction') {
      patch.artist = artistDisplay; patch.primaryArtist = primaryArtist; patch.neteaseArtistId = neteaseArtistId
      patch.artistIds = neArtistIds; patch.ownerArtistIds = neArtistIds; patch.isMultiArtist = neArtistIds.length > 1
    }
    await db.collection('albums').doc(albumDoc._id).update({ data:patch })
    return { success:true, albumId:albumDoc._id, sourceId:neteaseAlbumId, trackCount:tracks.length, guestCount:featuringGuests.length, artist:artistDisplay, primaryArtist, artistIds:neArtistIds, featureArtistIds:featureIds(albumDoc.ownershipSource === 'user-admin-correction' ? (albumDoc.artistIds || []) : neArtistIds, ownerIds), tracks, featuringGuests }
  } catch(e) { return { success:false, error:e.message } }
}
function normalizeTrack(song, idx, ownerIds, ownerNames) { const artists=(song.artists || song.ar || []).map(a=>({id:Number(a.id||0),name:String(a.name||'').trim()})).filter(a=>a.name); const guests=artists.filter(a=>isGuest(a, ownerIds, ownerNames)); return {songId:String(song.id||''),no:idx+1,name:song.name||'',duration:Number(song.duration||song.dt||0),artists,guests,hasFeaturing:guests.length>0} }
function collectGuests(tracks) { const map=new Map(); tracks.forEach(track=>(track.guests||[]).forEach(g=>{const key=g.id?String(g.id):g.name;if(!map.has(key))map.set(key,{id:g.id||0,name:g.name,count:0,trackNos:[]});const x=map.get(key);x.count++;x.trackNos.push(track.no)}));return Array.from(map.values()).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name)) }
function extractDescription(detail,album,albumDoc){const c=[album.description,album.desc,album.briefDesc,album.copywriter,albumDoc.description,detail.description,detail.desc,detail.data?.description,detail.data?.desc];return cleanText(c.find(v=>String(v||'').trim())||'')}
async function fetchAlbumDetail(id){for(const url of [`https://music.163.com/api/v1/album/${id}`,`https://music.163.com/api/album/${id}`]){try{const j=await httpsGetJson(url);if(j&&(j.code===200||j.album||j.data?.album))return j}catch(e){}}return null}
function httpsGetJson(url){return new Promise((resolve,reject)=>{const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:'https://music.163.com/',Accept:'application/json,text/plain,*/*'}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b))}catch(e){reject(e)}})});req.on('error',reject);req.setTimeout(12000,()=>{req.destroy();reject(new Error('timeout'))})})}
function cleanText(text){return String(text||'').replace(/\r\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim()}
