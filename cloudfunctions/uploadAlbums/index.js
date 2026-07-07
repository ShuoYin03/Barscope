const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db    = cloud.database()
const _     = db.command

/**
 * 批量 upsert 专辑数据（高效版）
 *
 * 策略：
 *   1. 一次批量查询找出哪些 sourceId 已存在
 *   2. 分成「待插入」和「待更新」两组
 *   3. Promise.allSettled 并行执行所有写操作
 *
 * event.albums  : Array<AlbumDoc>
 * event.action  : 'upsert'(默认) | 'insert_only'
 */
exports.main = async (event, context) => {
  var albums = event.albums || []
  var action = event.action || 'upsert'

  if (albums.length === 0) {
    return { inserted: 0, updated: 0, skipped: 0, errors: 0, total: 0 }
  }

  // ── 1. 批量查已存在的 sourceId ───────────────────────────────────────────
  var sourceIds = albums.map(function(a) { return a.sourceId }).filter(Boolean)

  var existResult = await db.collection('albums')
    .where({ sourceId: _.in(sourceIds) })
    .field({ _id: true, sourceId: true })
    .limit(sourceIds.length)
    .get()

  var existingMap = {}
  existResult.data.forEach(function(doc) {
    existingMap[doc.sourceId] = doc._id
  })

  // ── 2. 分组 ───────────────────────────────────────────────────────────────
  var toInsert = []
  var toUpdate = []
  var skipped  = 0

  albums.forEach(function(a) {
    if (!a.sourceId || !a.title || !a.artist) { skipped++; return }
    if (existingMap[a.sourceId]) {
      if (action === 'upsert') toUpdate.push(a)
      else skipped++
    } else {
      toInsert.push(a)
    }
  })

  // ── 3. 并行写入 ───────────────────────────────────────────────────────────
  var insertOps = toInsert.map(function(a) {
    return db.collection('albums').add({ data: Object.assign({ approved: false }, a) })
  })

  var updateOps = toUpdate.map(function(a) {
    var fields = {
      coverUrl:    a.coverUrl,
      releaseYear: a.releaseYear,
      genres:      a.genres,
      artist:      a.artist,
    }
    if (a.primaryArtist)   fields.primaryArtist   = a.primaryArtist
    if (a.neteaseArtistId) fields.neteaseArtistId = a.neteaseArtistId
    if (a.artistIds && a.artistIds.length) fields.artistIds = a.artistIds
    return db.collection('albums').doc(existingMap[a.sourceId]).update({ data: fields })
  })

  var results = await Promise.allSettled(insertOps.concat(updateOps))

  var insertResults = results.slice(0, toInsert.length)
  var updateResults = results.slice(toInsert.length)

  var insertOk = insertResults.filter(function(r) { return r.status === 'fulfilled' }).length
  var updateOk = updateResults.filter(function(r) { return r.status === 'fulfilled' }).length
  var errors   = results.filter(function(r) { return r.status === 'rejected' }).length

  return {
    inserted: insertOk,
    updated:  updateOk,
    skipped:  skipped,
    errors:   errors,
    total:    albums.length,
  }
}
