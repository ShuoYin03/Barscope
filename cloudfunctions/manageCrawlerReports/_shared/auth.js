// 自动生成，请勿手改。源文件在 shared/cloudfunctions/，改完运行 node scripts/sync-cloudfunctions-shared.js 重新同步。
const cloud = require('wx-server-sdk')

async function isAdmin(openId) {
  if (!openId) return false
  try {
    const db = cloud.database()
    const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
    return r.data.length > 0
  } catch (e) {
    return false
  }
}

module.exports = { isAdmin, checkAdmin: isAdmin }
