const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const albumDocId = event.albumId || event.id
  const sourceId = event.sourceId
  if (!albumDocId && !sourceId) return { success:false, error:'missing albumId or sourceId' }

  try {
    let albumDoc = null
    if (albumDocId) albumDoc = (await db.collection('albums').doc(albumDocId).get()).data
    else albumDoc = (await db.collection('albums').where({ sourceId:String(sourceId) }).limit(1).get()).data[0]
    if (!albumDoc) return { success:false, error:'album not found' }

    const neteaseAlbumId = String(sourceId || albumDoc.sourceId || '')
    if (!neteaseAlbumId) return { success:false, error:'missing sourceId' }
    const detail = await fetchAlbumDetail(neteaseAlbumId)
    if (!detail) return { success:false, error:'netease album api failed' }

    const album = detail.album || detail.data?.album || {}
    const songs = detail.songs || detail.data?.songs || album.songs || []
    // Only persisted album-level owners are allowed to exclude a song artist from featuring guests.
    // Never read album.artists here: Netease's API may mix track collaborators into that field.
    const albumOwnerNames = getAlbumOwnerNames(albumDoc)
    const tracks = songs.map((song, idx) => normalizeTrack(song, idx, albumOwnerNames))
    const featuringGuests = collectGuests(tracks)
    const patch = {
      description: extractDescription(detail, album, albumDoc),
      company: album.company || albumDoc.company || '',
      trackCount: tracks.length || album.size || albumDoc.trackCount || 0,
      tracks,
      featuringGuests,
      trackSyncedAt: db.serverDate(),
    }
    await db.collection('albums').doc(albumDoc._id).update({ data:patch })
    return { success:true, albumId:albumDoc._id, sourceId:neteaseAlbumId, trackCount:tracks.length, guestCount:featuringGuests.length, tracks, featuringGuests }
  } catch (e) { return { success:false, error:e.message } }
}

function getAlbumOwnerNames(albumDoc) {
  const names = new Set()
  // New authoritative fields, set by the album-ownership correction job.
  if (Array.isArray(albumDoc.collaboratorArtistNames) && albumDoc.collaboratorArtistNames.length) {
    albumDoc.collaboratorArtistNames.forEach(n => { if (String(n || '').trim()) names.add(String(n).trim()) })
  } else if (Array.isArray(albumDoc.collaboratorArtists) && albumDoc.collaboratorArtists.length) {
    albumDoc.collaboratorArtists.forEach(a => { if (a && String(a.name || '').trim()) names.add(String(a.name).trim()) })
  } else if (albumDoc.primaryArtist) {
    // Conservative legacy fallback: primary artist only. Do NOT split albumDoc.artist,
    // because old values may contain collaborators incorrectly promoted from individual tracks.
    names.add(String(albumDoc.primaryArtist).trim())
  }
  return names
}

function normalizeTrack(song, idx, albumOwnerNames) {
  const artists = (song.artists || song.ar || []).map(a => ({ id:Number(a.id || 0), name:String(a.name || '').trim() })).filter(a => a.name)
  const guests = artists.filter(a => !albumOwnerNames.has(a.name))
  return { songId:String(song.id || ''), no:idx + 1, name:song.name || '', duration:Number(song.duration || song.dt || 0), artists, guests, hasFeaturing:guests.length > 0 }
}
function collectGuests(tracks) {
  const map = new Map()
  tracks.forEach(track => (track.guests || []).forEach(guest => { const key=guest.id ? String(guest.id) : guest.name; if(!map.has(key)) map.set(key,{ id:guest.id || 0, name:guest.name, count:0, trackNos:[] }); const item=map.get(key); item.count += 1; item.trackNos.push(track.no) }))
  return Array.from(map.values()).sort((a,b) => b.count-a.count || a.name.localeCompare(b.name))
}
function extractDescription(detail, album, albumDoc) { const candidates=[album.description,album.desc,album.briefDesc,album.copywriter,albumDoc.description,detail.description,detail.desc,detail.data?.description,detail.data?.desc]; return cleanText(candidates.find(v=>String(v||'').trim()) || '') }
async function fetchAlbumDetail(albumId) { const urls=[`https://music.163.com/api/v1/album/${albumId}`,`https://music.163.com/api/album/${albumId}`]; for(const url of urls){try{const json=await httpsGetJson(url);if(json&&(json.code===200||json.album||json.data?.album))return json}catch(e){}}return null }
function httpsGetJson(url) { return new Promise((resolve,reject)=>{ const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',Referer:'https://music.163.com/',Accept:'application/json,text/plain,*/*'}},res=>{let buf='';res.on('data',c=>buf+=c);res.on('end',()=>{try{resolve(JSON.parse(buf))}catch(e){reject(e)}})});req.on('error',reject);req.setTimeout(12000,()=>{req.destroy();reject(new Error('timeout'))}) }) }
function cleanText(text) { return String(text || '').replace(/\r\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim() }
