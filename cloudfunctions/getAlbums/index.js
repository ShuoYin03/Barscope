const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function sortList(list, sortBy) {
  const field = sortBy === 'releaseYear' ? 'releaseDate' : 'avgScore'
  const direction = sortBy === 'releaseYear' ? 1 : -1
  return list.slice().sort((a, b) => {
    const av = a[field] || (direction === 1 ? '9999-99-99' : 0)
    const bv = b[field] || (direction === 1 ? '9999-99-99' : 0)
    return direction * (av > bv ? 1 : av < bv ? -1 : 0)
  })
}

exports.main = async (event) => {
  var genre = event.genre
  var year = event.year
  var month = event.month
  var artistId = event.artistId
  var page = event.page || 1
  var pageSize = event.pageSize || 20
  var id = event.id
  var keyword = event.keyword || ''
  var sortBy = event.sortBy || 'avgScore'

  try {
    if (id) {
      var result = await db.collection('albums').doc(id).get()
      return { success: true, album: result.data }
    }

    if (keyword) {
      var re = db.RegExp({ regexp: keyword, options: 'i' })
      var res1 = await db.collection('albums').where({ approved: true, title: re }).limit(50).get()
      var res2 = await db.collection('albums').where({ approved: true, artist: re }).limit(50).get()
      var seen = {}, seenKey = {}, merged = []
      res1.data.concat(res2.data).forEach(function(a) {
        if (seen[a._id]) return
        var dupKey = (a.title || '').toLowerCase() + '|||' + (a.artist || '').toLowerCase()
        if (seenKey[dupKey]) return
        seen[a._id] = true; seenKey[dupKey] = true; merged.push(a)
      })
      if (genre) merged = merged.filter(function(a) { return a.genres && a.genres.indexOf(genre) !== -1 })
      if (year) merged = merged.filter(function(a) { var y = a.releaseYear; if (year === '2010s') return y >= 2010 && y <= 2017; if (year === '2000s') return y >= 2000 && y <= 2009; return y === parseInt(year) })
      if (month && year && /^\d{4}$/.test(String(year))) merged = merged.filter(function(a) { return String(a.releaseDate || '').slice(5, 7) === String(month).padStart(2, '0') })
      merged.sort(function(a, b) { return String(a.releaseDate || '9999-99-99').localeCompare(String(b.releaseDate || '9999-99-99')) })
      return { success: true, list: merged, total: merged.length, page: 1, pageSize: merged.length }
    }

    if (artistId) {
      const artistKey = String(artistId)
      const pair = await Promise.all([
        db.collection('albums').where({ approved: true, neteaseArtistId: artistKey }).limit(1000).get(),
        db.collection('albums').where({ approved: true, collaboratorArtistIds: _.all([artistKey]) }).limit(1000).get(),
      ])
      const seen = {}, merged = []
      pair[0].data.concat(pair[1].data).forEach(a => { if (!seen[a._id]) { seen[a._id] = true; merged.push(a) } })
      const sorted = sortList(merged, sortBy)
      const start = (page - 1) * pageSize
      return { success: true, list: sorted.slice(start, start + pageSize), total: sorted.length, page, pageSize }
    }

    var query = db.collection('albums')
    var filters = { approved: true }
    if (genre) filters.genres = _.all([genre])
    else if (year) {
      if (year === '2010s') filters.releaseYear = _.gte(2010).and(_.lte(2017))
      else if (year === '2000s') filters.releaseYear = _.gte(2000).and(_.lte(2009))
      else { var y = parseInt(year); if (!isNaN(y)) filters.releaseYear = _.eq(y) }
    }
    if (month && year && /^\d{4}$/.test(String(year))) {
      var mm = String(month).padStart(2, '0')
      filters.releaseDate = db.RegExp({ regexp: '^' + String(year) + '-' + mm + '-', options: '' })
    }
    query = query.where(filters)
    var countResult = await query.count()
    var total = countResult.total
    var skip = (page - 1) * pageSize
    var field = sortBy === 'releaseYear' ? 'releaseDate' : 'avgScore'
    var direction = sortBy === 'releaseYear' ? 'asc' : 'desc'
    var listResult = await query.orderBy(field, direction).skip(skip).limit(pageSize).get()
    return { success: true, list: listResult.data, total, page, pageSize }
  } catch (err) { return { success: false, error: err.message } }
}
