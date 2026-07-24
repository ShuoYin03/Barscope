const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _  = db.command

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { action }  = event

  try {
    // Admin check
    const { data: admins } = await db.collection('users')
      .where({ openId: OPENID, type: 'admin' })
      .limit(1)
      .get()
    if (admins.length === 0) {
      return { success: false, error: '无权限' }
    }

    if (action === 'listUsers') {
      const { keyword = '', page = 1, pageSize = 20 } = event
      const skip = (page - 1) * pageSize

      var query = db.collection('users')
      if (keyword) {
        query = query.where({ nickName: db.RegExp({ regexp: keyword, options: 'i' }) })
      }

      const { data } = await query
        .orderBy('joinedAt', 'desc')
        .skip(skip)
        .limit(pageSize)
        .get()

      const list = data.map(u => ({
        openId:      u.openId,
        nickName:    u.nickName || '用户',
        avatarUrl:   u.avatarUrl || '',
        type:        u.type || 'normal',
        reviewCount: u.reviewCount || 0,
        joinedAt:    u.joinedAt ? formatDate(u.joinedAt) : '',
      }))

      return { success: true, list }
    }

    if (action === 'grantCritic') {
      const { openId } = event
      if (!openId) return { success: false, error: '缺少 openId' }

      await db.collection('users').where({ openId }).update({
        data: { type: 'critic' },
      })
      return { success: true }
    }

    if (action === 'revokeCritic') {
      const { openId } = event
      if (!openId) return { success: false, error: '缺少 openId' }

      await db.collection('users').where({ openId }).update({
        data: { type: 'normal' },
      })
      return { success: true }
    }

    if (action === 'grantAdmin') {
      const { openId } = event
      if (!openId) return { success: false, error: '缺少 openId' }

      await db.collection('users').where({ openId }).update({
        data: { type: 'admin' },
      })
      return { success: true }
    }

    if (action === 'revokeAdmin') {
      const { openId } = event
      if (!openId) return { success: false, error: '缺少 openId' }
      if (openId === OPENID) return { success: false, error: '不能撤销自己的管理员身份' }

      await db.collection('users').where({ openId }).update({
        data: { type: 'normal' },
      })
      return { success: true }
    }

    return { success: false, error: '未知 action' }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function formatDate(date) {
  try {
    const d = new Date(date)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  } catch {
    return ''
  }
}
