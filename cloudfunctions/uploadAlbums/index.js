const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const PINYIN_STARTS = [['A','阿'],['B','芭'],['C','嚓'],['D','搭'],['E','蛾'],['F','发'],['G','噶'],['H','哈'],['J','击'],['K','喀'],['L','垃'],['M','妈'],['N','拿'],['O','哦'],['P','啪'],['Q','期'],['R','然'],['S','撒'],['T','塌'],['W','挖'],['X','昔'],['Y','压'],['Z','匝']]
function pinyinInitial(ch){ let letter='#'; for(const [initial,startChar] of PINYIN_STARTS){ if(ch.localeCompare(startChar,'zh-Hans-CN-u-co-pinyin')>=0)letter=initial; else break } return letter }
function firstLetter(name){ for(const ch of Array.from(String(name||'').trim())){ if(/[A-Za-z]/.test(ch))return ch.toUpperCase(); if(/[一-鿿]/.test(ch))return pinyinInitial(ch) } return '#' }

async function fetchDeletedSourceIds(sourceIds) {
  const blocked = new Set()
  const ids = Array.from(new Set((sourceIds || []).map(x => String(x || '').trim()).filter(Boolean)))
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const r = await db.collection('album_candidates')
        .where({ sourceId: _.in(ids.slice(i, i + 100)), status: 'deleted' })
        .field({ sourceId: true })
        .limit(100)
        .get()
      ;(r.data || []).forEach(x => { if (x.sourceId) blocked.add(String(x.sourceId)) })
    } catch (e) {}
  }
  return blocked
}

/** Batch upsert albums, preserving album-level co-creators from crawler imports. */
exports.main = async event => {
  const albums = event.albums || []
  const action = event.action || 'upsert'
  if (!albums.length) return { inserted:0, updated:0, skipped:0, blocked:0, errors:0, total:0 }

  const sourceIds = albums.map(a => String(a.sourceId || '')).filter(Boolean)
  const [existing, deletedSourceIds] = await Promise.all([
    db.collection('albums').where({ sourceId: _.in(sourceIds) }).field({ _id:true, sourceId:true, ownershipSource:true, approved:true, movedToCandidate:true }).limit(sourceIds.length).get(),
    fetchDeletedSourceIds(sourceIds),
  ])

  const existingMap = {}
  existing.data.forEach(d => { existingMap[String(d.sourceId)] = { id:d._id, ownershipSource:d.ownershipSource, approved:d.approved, movedToCandidate:d.movedToCandidate } })

  const toInsert = [], toUpdate = []
  let skipped = 0, blocked = 0
  albums.forEach(a => {
    const sourceId = String(a.sourceId || '')
    if (!sourceId || !a.title || !a.artist) { skipped++; return }

    if (existingMap[sourceId]) {
      // Existing catalog decisions are sticky. A crawler refresh may update metadata, but it must
      // never hide or re-route an approved album. The only supported way out of the catalog is the
      // explicit moveAlbumToCandidate/admin-hide flow.
      action === 'upsert' ? toUpdate.push(a) : skipped++
      return
    }

    // A human-deleted album is tombstoned in album_candidates. Automated crawlers/importers must
    // never resurrect it. Only submitAlbumRequest may explicitly reopen that tombstone for review.
    if (deletedSourceIds.has(sourceId)) { blocked++; return }
    toInsert.push(a)
  })

  // Crawler-discovered albums that pass the crawler pipeline belong in the visible catalog by
  // default. The old approved:false default made perfectly valid imports appear as "历史未显示"
  // and caused albums to bounce between visible/hidden states on later runs.
  const insertOps = toInsert.map(a => db.collection('albums').add({
    data:Object.assign({
      approved:true,
      catalogDecision:'approved',
      catalogDecisionSource:'crawler-import',
      titleLetter:firstLetter(a.title),
      isMultiArtist:Array.isArray(a.artistIds) && a.artistIds.length > 1,
    }, a),
  }))

  const updateOps = toUpdate.map(a => {
    const entry = existingMap[String(a.sourceId)]
    const fields = { coverUrl:a.coverUrl, releaseYear:a.releaseYear, releaseDate:a.releaseDate, genres:a.genres }
    // Never write approved/movedToCandidate here. Visibility is a human/catalog decision, not metadata.
    if (entry.ownershipSource !== 'user-admin-correction') {
      fields.artist = a.artist
      if (a.primaryArtist) fields.primaryArtist = a.primaryArtist
      if (a.neteaseArtistId) fields.neteaseArtistId = a.neteaseArtistId
      if (Array.isArray(a.artistIds) && a.artistIds.length) { fields.artistIds = a.artistIds.map(String); fields.isMultiArtist = a.artistIds.length > 1 }
    }
    return db.collection('albums').doc(entry.id).update({ data:fields })
  })

  const results = await Promise.allSettled(insertOps.concat(updateOps))
  return {
    inserted:results.slice(0,toInsert.length).filter(r=>r.status==='fulfilled').length,
    updated:results.slice(toInsert.length).filter(r=>r.status==='fulfilled').length,
    skipped,
    blocked,
    errors:results.filter(r=>r.status==='rejected').length,
    total:albums.length,
  }
}