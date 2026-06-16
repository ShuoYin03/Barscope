const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _  = db.command

/**
 * 获取当前用户的收藏列表，或检查某张专辑是否已收藏
 *
 * event.checkAlbum : string  — 传入时只返回 { isFavorited: bool }
 * （无参数时）               — 返回完整收藏列表（含专辑详情）
 */
exports.main = async (event, context) => {
  var OPENID = cloud.getWXContext().OPENID

  try {
    // ── 单张专辑收藏状态检查 ───────────────────────────────────────────────
    if (event.checkAlbum) {
      var check = await db.collection('favorites')
        .where({ userId: OPENID, albumId: event.checkAlbum })
        .get()
      return { success: true, isFavorited: check.data.length > 0 }
    }

    // ── 获取完整收藏列表 ───────────────────────────────────────────────────
    var favsResult = await db.collection('favorites')
      .where({ userId: OPENID })
      .orderBy('createdAt', 'desc')
      .get()

    var favs = favsResult.data
    if (favs.length === 0) return { success: true, list: [] }

    var albumIds = favs.map(function(f) { return f.albumId })

    var albumsResult = await db.collection('albums')
      .where({ _id: _.in(albumIds) })
      .get()

    // 保持收藏顺序（最新收藏在前）
    var albumMap = {}
    albumsResult.data.forEach(function(a) { albumMap[a._id] = a })

    var list = favs
      .map(function(f) { return albumMap[f.albumId] })
      .filter(Boolean)

    return { success: true, list: list }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
