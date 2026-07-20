const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  const action = String(event.action || 'list')
  try {
    if (action === 'list') return listQQRecords(event)
    if (action === 'artists') return listArtists(event)
    if (action === 'update') return updateRecords(event)
    return { success:false, error:'unknown action' }
  } catch (e) {
    console.error('manageQQAlbumBackfill failed:', e)
    return { success:false, error:e && e.message ? e.message : 'QQ专辑回填失败' }
  }
}

async function listQQRecords(event) {
  const collection = event.collection === 'album_candidates' ? 'album_candidates' : 'albums'
  const offset = Math.max(Number(event.offset || 0), 0)
  const limit = Math.min(Math.max(Number(event.limit || 100), 1), 100)
  const totalRes = await db.collection(collection).count()
  const page = await db.collection(collection).skip(offset).limit(limit).get()
  const list = (page.data || []).filter(isQQRecord).map(row => ({
    _id:row._id,
    title:row.title || '',
    artist:row.artist || '',
    primaryArtist:row.primaryArtist || '',
    source:row.source || '',
    sourcePlatform:row.sourcePlatform || '',
    sourceId:row.sourceId || '',
    sourceKey:row.sourceKey || '',
    qqAlbumMid:row.qqAlbumMid || '',
    qqAlbumId:row.qqAlbumId || '',
    qqArtistMid:row.qqArtistMid || '',
    qqArtistMids:Array.isArray(row.qqArtistMids) ? row.qqArtistMids : [],
    neteaseArtistId:row.neteaseArtistId || '',
    artistIds:Array.isArray(row.artistIds) ? row.artistIds : [],
    ownerArtistIds:Array.isArray(row.ownerArtistIds) ? row.ownerArtistIds : [],
    ownerArtists:Array.isArray(row.ownerArtists) ? row.ownerArtists : [],
    releaseDate:row.releaseDate || '',
    releaseYear:row.releaseYear || 0,
    company:row.company || '',
    trackCount:Number(row.trackCount || 0),
    status:row.status || '',
  }))
  return { success:true, collection, offset, limit, total:Number(totalRes.total || 0), list }
}

function isQQRecord(row) {
  const source = String(row.sourcePlatform || row.source || '').toLowerCase()
  return source === 'qq' || !!row.qqAlbumMid || String(row.sourceKey || '').startsWith('qq:')
}

async function listArtists(event) {
  const offset = Math.max(Number(event.offset || 0), 0)
  const limit = Math.min(Math.max(Number(event.limit || 100), 1), 100)
  const totalRes = await db.collection('artist_candidates').where({status:'approved'}).count()
  const res = await db.collection('artist_candidates').where({status:'approved'})
    .field({_id:true,artistId:true,artistName:true,aliases:true,aka:true})
    .skip(offset).limit(limit).get()
  return { success:true, offset, limit, total:Number(totalRes.total || 0), list:res.data || [] }
}

async function updateRecords(event) {
  const collection = event.collection === 'album_candidates' ? 'album_candidates' : 'albums'
  const updates = Array.isArray(event.updates) ? event.updates.slice(0, 20) : []
  let updated = 0
  let failed = 0
  const errors = []
  for (const item of updates) {
    try {
      const id = String(item && item._id || '').trim()
      if (!id) { failed++; continue }
      const patch = Object.assign({}, item.patch || {})
      delete patch._id
      // Never touch ratings/reviews/approval state during metadata backfill.
      delete patch.avgScore
      delete patch.reviewCount
      delete patch.approved
      delete patch.status
      delete patch.decision
      await db.collection(collection).doc(id).update({ data:patch })
      updated++
    } catch (e) {
      failed++
      errors.push(String(e && e.message || e))
    }
  }
  return { success:failed === 0, collection, updated, failed, errors:errors.slice(0,10) }
}
