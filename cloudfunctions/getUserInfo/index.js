const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()

  try {
    const { data } = await db.collection('users').where({ openId: OPENID }).get()

    if (data.length === 0) {
      return { success: false, error: 'user not found' }
    }

    return { success: true, user: data[0] }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
