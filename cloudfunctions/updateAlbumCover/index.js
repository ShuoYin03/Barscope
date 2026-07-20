const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, error: '请先登录' }

  const isAdmin = await checkAdmin(OPENID)
  if (!isAdmin) return { success: false, error: '仅管理员可直接修改封面' }

  const albumId = String(event.albumId || '').trim()
  const coverUrl = String(event.coverUrl || '').trim()
  if (!albumId) return { success: false, error: '缺少专辑ID' }
  if (!coverUrl) return { success: false, error: '缺少封面地址' }

  let album
  try {
    album = (await db.collection('albums').doc(albumId).get()).data
  } catch (e) {
    return { success: false, error: '专辑不存在' }
  }
  if (!album) return { success: false, error: '专辑不存在' }

  await db.collection('albums').doc(albumId).update({
    data: {
      coverUrl,
      coverUpdatedBy: OPENID,
      coverUpdatedAt: db.serverDate(),
    },
  })

  return { success: true, coverUrl }
}

async function checkAdmin(openId) {
  try {
    const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
    return r.data.length > 0
  } catch (e) {
    return false
  }
}
