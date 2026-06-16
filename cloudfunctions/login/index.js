const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()

  try {
    const { data } = await db.collection('users').where({ openId: OPENID }).get()

    if (data.length > 0) {
      return { success: true, user: data[0], isNew: false }
    }

    // First time login — create user
    const newUser = {
      openId: OPENID,
      nickName: event.nickName || '说唱迷',
      avatarUrl: event.avatarUrl || '',
      type: 'normal',
      bio: '',
      reviewCount: 0,
      joinedAt: db.serverDate(),
    }

    const result = await db.collection('users').add({ data: newUser })
    return { success: true, user: { _id: result._id, ...newUser }, isNew: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
