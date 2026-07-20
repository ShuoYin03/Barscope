const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const PINYIN_STARTS = [['A','阿'],['B','芭'],['C','嚓'],['D','搭'],['E','蛾'],['F','发'],['G','噶'],['H','哈'],['J','击'],['K','喀'],['L','垃'],['M','妈'],['N','拿'],['O','哦'],['P','啪'],['Q','期'],['R','然'],['S','撒'],['T','塌'],['W','挖'],['X','昔'],['Y','压'],['Z','匝']]
function pinyinInitial(ch){ let letter='#'; for(const [initial,startChar] of PINYIN_STARTS){ if(ch.localeCompare(startChar,'zh-Hans-CN-u-co-pinyin')>=0)letter=initial; else break } return letter }
function firstLetter(name){ for(const ch of Array.from(String(name||'').trim())){ if(/[A-Za-z]/.test(ch))return ch.toUpperCase(); if(/[一-鿿]/.test(ch))return pinyinInitial(ch) } return '#' }

/** Batch upsert albums, preserving album-level co-creators from crawler imports. */
exports.main = async event => {
  const albums = event.albums || []
  if (!albums.length) return { inserted:0, updated:0, skipped:0, errors:0, total:0 }
  const sourceIds = albums.map(a => a.sourceId).filter(Boolean)
  const existing = await db.collection('albums').where({ sourceId: _.in(sourceIds) }).field({ _id:true, sourceId:true, ownershipSource:true }).limit(sourceIds.length).get()
  const existingMap = {}; existing.data.forEach(d => { existingMap[d.sourceId] = { id:d._id, ownershipSource:d.ownershipSource } })
  const toInsert = [], toUpdate = []; let skipped = 0
  albums.forEach(a => {
    if (!a.sourceId || !a.title || !a.artist) { skipped++; return }
    if (existingMap[a.sourceId]) toUpdate.push(a)
    else toInsert.push(a)
  })
  const insertOps = toInsert.map(a => db.collection('albums').add({ data:Object.assign({ approved:false, titleLetter:firstLetter(a.title), isMultiArtist:Array.isArray(a.artistIds) && a.artistIds.length > 1 }, a) }))
  const updateOps = toUpdate.map(a => {
    const entry = existingMap[a.sourceId]
    const fields = { coverUrl:a.coverUrl, releaseYear:a.releaseYear, releaseDate:a.releaseDate, genres:a.genres }
    // Preserve manual ownership corrections: an admin's deliberate fix must survive crawler re-imports.
    if (entry.ownershipSource !== 'user-admin-correction') {
      fields.artist = a.artist
      if (a.primaryArtist) fields.primaryArtist = a.primaryArtist
      if (a.neteaseArtistId) fields.neteaseArtistId = a.neteaseArtistId
      if (Array.isArray(a.artistIds) && a.artistIds.length) { fields.artistIds = a.artistIds.map(String); fields.isMultiArtist = a.artistIds.length > 1 }
    }
    return db.collection('albums').doc(entry.id).update({ data:fields })
  })
  const results = await Promise.allSettled(insertOps.concat(updateOps))
  return { inserted:results.slice(0,toInsert.length).filter(r=>r.status==='fulfilled').length, updated:results.slice(toInsert.length).filter(r=>r.status==='fulfilled').length, skipped, errors:results.filter(r=>r.status==='rejected').length, total:albums.length }
}
