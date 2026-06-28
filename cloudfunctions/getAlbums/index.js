const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  var genre    = event.genre
  var year     = event.year
  var artistId = event.artistId
  var page     = event.page || 1
  var pageSize = event.pageSize || 20
  var id       = event.id
  var keyword  = event.keyword || ''
  var sortBy   = event.sortBy || 'avgScore'   // 'avgScore' | 'releaseYear'

  try {
    // ── 单条专辑查询 ──────────────────────────────────────────────────────────
    if (id) {
      var result = await db.collection('albums').doc(id).get()
      return { success: true, album: result.data }
    }

    // ── 关键词搜索（title OR artist）─────────────────────────────────────────
    if (keyword) {
      var re   = db.RegExp({ regexp: keyword, options: 'i' })
      var res1 = await db.collection('albums').where({ approved: true, title: re }).limit(50).get()
      var res2 = await db.collection('albums').where({ approved: true, artist: re }).limit(50).get()
      var seen = {}
      var seenKey = {}
      var merged = []
      res1.data.concat(res2.data).forEach(function(a) {
        if (seen[a._id]) return
        var dupKey = (a.title || '').toLowerCase() + '|||' + (a.artist || '').toLowerCase()
        if (seenKey[dupKey]) return
        seen[a._id] = true
        seenKey[dupKey] = true
        merged.push(a)
      })
      if (genre) {
        merged = merged.filter(function(a) {
          return a.genres && a.genres.indexOf(genre) !== -1
        })
      }
      if (year) {
        merged = merged.filter(function(a) {
          var y = a.releaseYear
          if (year === '2010s') return y >= 2010 && y <= 2017
          if (year === '2000s') return y >= 2000 && y <= 2009
          return y === parseInt(year)
        })
      }
      return { success: true, list: merged, total: merged.length, page: 1, pageSize: merged.length }
    }

    // ── 分页列表 ──────────────────────────────────────────────────────────────
    var query = db.collection('albums')
    var yearFilter = null
    if (year) {
      if (year === '2010s') {
        yearFilter = _.gte(2010).and(_.lte(2017))
      } else if (year === '2000s') {
        yearFilter = _.gte(2000).and(_.lte(2009))
      } else {
        var y = parseInt(year)
        if (!isNaN(y)) yearFilter = _.eq(y)
      }
    }
    if (artistId) {
      query = query.where({ approved: true, neteaseArtistId: artistId })
    } else if (genre) {
      query = query.where({ approved: true, genres: _.all([genre]) })
    } else if (yearFilter) {
      query = query.where({ approved: true, releaseYear: yearFilter })
    } else {
      query = query.where({ approved: true })
    }

    var countResult = await query.count()
    var total = countResult.total
    var skip  = (page - 1) * pageSize
    var field = sortBy === 'releaseYear' ? 'releaseYear' : 'avgScore'

    var listResult = await query
      .orderBy(field, 'desc')
      .skip(skip)
      .limit(pageSize)
      .get()

    return { success: true, list: listResult.data, total, page, pageSize }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
