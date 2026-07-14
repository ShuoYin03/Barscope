const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!(await isAdmin(OPENID))) return { success:false, error:'unauthorized' }
  const albumId = String(event.albumId || '').trim()
  const submitted = Array.isArray(event.tracks) ? event.tracks : []
  if (!albumId) return { success:false, error:'missing albumId' }
  if (!submitted.length) return { success:false, error:'missing tracks' }

  const albumDoc = (await db.collection('albums').doc(albumId).get()).data
  if (!albumDoc) return { success:false, error:'album not found' }

  // Owners are assumed to perform on every track; admins only edit each track's featuring guests.
  const ownerArtists = (Array.isArray(albumDoc.ownerArtists) ? albumDoc.ownerArtists : [])
    .map(o => ({ id:Number(o && o.id || 0), name:String(o && o.name || '').trim() })).filter(o => o.name)
  const existingBySongId = new Map((Array.isArray(albumDoc.tracks) ? albumDoc.tracks : []).map(t => [String(t.songId || ''), t]))

  const tracks = submitted.map((t, idx) => {
    const songId = String(t.songId || '')
    const old = existingBySongId.get(songId) || {}
    const guests = (Array.isArray(t.guests) ? t.guests : [])
      .map(g => ({ id:Number(g && g.id || 0), name:String(g && g.name || '').trim() }))
      .filter(g => g.name)
    const seen = new Set()
    const artists = []
    ownerArtists.concat(guests).forEach(a => {
      const key = a.id ? `id:${a.id}` : `name:${a.name}`
      if (seen.has(key)) return
      seen.add(key)
      artists.push(a)
    })
    return {
      songId,
      no: idx + 1,
      name: String(t.name || old.name || '').trim(),
      duration: Number(old.duration || 0),
      artists,
      guests,
      hasFeaturing: guests.length > 0,
    }
  })

  const featuringGuests = collectGuests(tracks)
  await db.collection('albums').doc(albumId).update({ data: { tracks, featuringGuests, trackCount: tracks.length } })
  return { success:true, tracks, featuringGuests }
}

async function isAdmin(openId) { if (!openId) return false; const r = await db.collection('users').where({ openId, type:'admin' }).limit(1).get(); return r.data.length > 0 }
function collectGuests(tracks) { const map=new Map(); tracks.forEach(track=>(track.guests||[]).forEach(g=>{const key=g.id?String(g.id):g.name;if(!map.has(key))map.set(key,{id:g.id||0,name:g.name,count:0,trackNos:[]});const x=map.get(key);x.count++;x.trackNos.push(track.no)}));return Array.from(map.values()).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name)) }
