const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/**
 * 收藏一张专辑（幂等）
 * event.albumId : string
 */
exports.main = async (event, context) => {
  var OPENID  = cloud.getWXContext().OPENID
  var albumId = event.albumId

  if (!albumId) return { success: false, error: 'albumId required' }

  try {
    var existing = await db.collection('favorites')
      .where({ userId: OPENID, albumId: albumId })
      .get()

    if (existing.data.length > 0) {
      return { success: true, alreadyFavorited: true }
    }

    await db.collection('favorites').add({
      data: {
        userId:    OPENID,
        albumId:   albumId,
        createdAt: db.serverDate(),
      },
    })

    return { success: true, alreadyFavorited: false }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
