const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, error: '请先登录后投稿' }

  const featureId = String(event.featureId || '').trim()
  const featureTitle = String(event.featureTitle || '').trim()
  const category = String(event.category || '').trim()
  const proposalTitle = String(event.proposalTitle || '').trim()
  const idea = String(event.idea || '').trim()
  const outline = String(event.outline || '').trim()
  const wechat = String(event.wechat || '').trim()
  const links = String(event.links || '').trim()

  if (!featureId || !featureTitle) return { success: false, error: '专题信息缺失' }
  if (proposalTitle.length < 2) return { success: false, error: '请填写项目标题' }
  if (idea.length < 30) return { success: false, error: '项目想法至少填写 30 字' }
  if (wechat.length < 3) return { success: false, error: '请填写有效微信号' }

  const pending = await db.collection('feature_proposals').where({
    featureId,
    submitterOpenId: OPENID,
    status: 'pending',
  }).limit(1).get()

  if (pending.data.length) {
    return { success: false, error: '你已经提交过该栏目的企划，请等待联系' }
  }

  const userResult = await db.collection('users').where({ openId: OPENID }).limit(1).get()
  const user = userResult.data[0] || {}

  const result = await db.collection('feature_proposals').add({
    data: {
      featureId,
      featureTitle,
      category,
      proposalTitle,
      idea,
      outline,
      wechat,
      links,
      submitterOpenId: OPENID,
      submitterName: user.nickName || '',
      submitterAvatar: user.avatarUrl || '',
      status: 'pending',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  })

  return { success: true, id: result._id }
}
