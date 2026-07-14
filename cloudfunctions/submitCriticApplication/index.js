const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function clean(value, max) {
  return String(value || '').trim().slice(0, max)
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, error: '请先登录' }

  const action = event.action || 'submit'

  if (action === 'getMine') {
    try {
      const result = await db.collection('critic_applications')
        .where({ openId: OPENID })
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get()
      return { success: true, application: result.data[0] || null }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  if (action !== 'submit') return { success: false, error: 'unknown action' }

  const wechatId = clean(event.wechatId, 80)
  const reason = clean(event.reason, 1200)
  const sampleReview = clean(event.sampleReview, 3000)
  const portfolioUrl = clean(event.portfolioUrl, 500)
  const specialties = Array.isArray(event.specialties)
    ? event.specialties.map(x => clean(x, 30)).filter(Boolean).slice(0, 8)
    : []

  if (!wechatId) return { success: false, error: '请填写微信号' }
  if (reason.length < 30) return { success: false, error: '申请理由至少填写 30 字' }
  if (sampleReview.length < 100 && !portfolioUrl) {
    return { success: false, error: '请提交至少 100 字的乐评样稿，或填写作品链接' }
  }

  try {
    const userRes = await db.collection('users').where({ openId: OPENID }).limit(1).get()
    const user = userRes.data[0] || {}
    if (user.type === 'critic' || user.type === 'admin') {
      return { success: false, error: '你已经拥有乐评人权限' }
    }

    const existing = await db.collection('critic_applications')
      .where({ openId: OPENID, status: 'pending' })
      .limit(1)
      .get()
    if (existing.data.length) {
      return { success: false, error: '你已有待审核申请，请耐心等待' }
    }

    const now = db.serverDate()
    const data = {
      openId: OPENID,
      nickName: clean(user.nickName || event.nickName, 80),
      avatarUrl: clean(user.avatarUrl || event.avatarUrl, 500),
      wechatId,
      reason,
      sampleReview,
      portfolioUrl,
      specialties,
      status: 'pending',
      adminNote: '',
      createdAt: now,
      updatedAt: now,
      reviewedAt: null,
      reviewedBy: '',
    }

    const result = await db.collection('critic_applications').add({ data })
    return { success: true, id: result._id, status: 'pending' }
  } catch (err) {
    console.error('submitCriticApplication failed:', err)
    return { success: false, error: err.message }
  }
}
