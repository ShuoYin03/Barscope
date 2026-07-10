const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()

  try {
    const { data } = await db.collection('users').where({ openId: OPENID }).get()
    const nickName = String(event.nickName || '').trim()
    const avatarUrl = String(event.avatarUrl || '').trim()

    if (data.length > 0) {
      const existing = data[0]
      const patch = {}
      if (nickName && nickName !== existing.nickName) patch.nickName = nickName
      if (avatarUrl && avatarUrl !== existing.avatarUrl) patch.avatarUrl = avatarUrl
      if (Object.keys(patch).length) {
        await db.collection('users').doc(existing._id).update({ data: patch })
        Object.assign(existing, patch)
      }
      return { success: true, user: existing, isNew: false }
    }

    // First time login — create user
    const newUser = {
      openId: OPENID,
      nickName: nickName || '说唱迷',
      avatarUrl: avatarUrl || '',
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
