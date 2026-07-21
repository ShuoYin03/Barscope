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
