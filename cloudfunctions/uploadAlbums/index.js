const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/** Batch upsert albums, preserving album-level co-creators from crawler imports. */
exports.main = async event => {
  const albums = event.albums || []
  const action = event.action || 'upsert'
  if (!albums.length) return { inserted:0, updated:0, skipped:0, errors:0, total:0 }
  const sourceIds = albums.map(a => a.sourceId).filter(Boolean)
  const existing = await db.collection('albums').where({ sourceId: _.in(sourceIds) }).field({ _id:true, sourceId:true }).limit(sourceIds.length).get()
  const existingMap = {}; existing.data.forEach(d => { existingMap[d.sourceId] = d._id })
  const toInsert = [], toUpdate = []; let skipped = 0
  albums.forEach(a => {
    if (!a.sourceId || !a.title || !a.artist) { skipped++; return }
    if (existingMap[a.sourceId]) action === 'upsert' ? toUpdate.push(a) : skipped++
    else toInsert.push(a)
  })
  const insertOps = toInsert.map(a => db.collection('albums').add({ data:Object.assign({ approved:false }, a) }))
  const updateOps = toUpdate.map(a => {
    const fields = { coverUrl:a.coverUrl, releaseYear:a.releaseYear, releaseDate:a.releaseDate, genres:a.genres, artist:a.artist }
    if (a.primaryArtist) fields.primaryArtist = a.primaryArtist
    if (a.neteaseArtistId) fields.neteaseArtistId = a.neteaseArtistId
    if (Array.isArray(a.artistIds) && a.artistIds.length) fields.artistIds = a.artistIds.map(String)
    return db.collection('albums').doc(existingMap[a.sourceId]).update({ data:fields })
  })
  const results = await Promise.allSettled(insertOps.concat(updateOps))
  return { inserted:results.slice(0,toInsert.length).filter(r=>r.status==='fulfilled').length, updated:results.slice(toInsert.length).filter(r=>r.status==='fulfilled').length, skipped, errors:results.filter(r=>r.status==='rejected').length, total:albums.length }
}
