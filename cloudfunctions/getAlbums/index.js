const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  var genre    = event.genre
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
      var merged = []
      res1.data.concat(res2.data).forEach(function(a) {
        if (!seen[a._id]) { seen[a._id] = true; merged.push(a) }
      })
      if (genre) {
        merged = merged.filter(function(a) {
          return a.genres && a.genres.indexOf(genre) !== -1
        })
      }
      return { success: true, list: merged, total: merged.length, page: 1, pageSize: merged.length }
    }

    // ── 分页列表 ──────────────────────────────────────────────────────────────
    var query = db.collection('albums')
    if (genre) {
      query = query.where({ approved: true, genres: _.all([genre]) })
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
