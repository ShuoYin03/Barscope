const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!(await isAdmin(OPENID))) return { success: false, error: 'unauthorized' }

  const page = Math.max(1, Number(event.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(event.pageSize) || 50))

  try {
    const query = db.collection('albums').where({ approved: false })
    const countResult = await query.count()
    const result = await query
      .orderBy('releaseYear', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get()

    return {
      success: true,
      list: result.data,
      total: countResult.total,
      page,
      pageSize,
      hasMore: page * pageSize < countResult.total,
    }
  } catch (error) {
    return { success: false, error: error.message || 'query failed' }
  }
}

async function isAdmin(openId) {
  if (!openId) return false
  const result = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
  return result.data.length > 0
}
