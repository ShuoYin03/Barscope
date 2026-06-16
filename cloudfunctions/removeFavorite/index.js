const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/**
 * 取消收藏一张专辑
 * event.albumId : string
 */
exports.main = async (event, context) => {
  var OPENID  = cloud.getWXContext().OPENID
  var albumId = event.albumId

  if (!albumId) return { success: false, error: 'albumId required' }

  try {
    await db.collection('favorites')
      .where({ userId: OPENID, albumId: albumId })
      .remove()

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
