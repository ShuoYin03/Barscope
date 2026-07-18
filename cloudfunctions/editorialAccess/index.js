const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, allowed: false, error: '请先登录' }

  const action = String(event.action || 'mine')

  if (action === 'mine') {
    const result = await db.collection('feature_proposals').where({
      submitterOpenId: OPENID,
      status: 'approved',
    }).orderBy('updatedAt', 'desc').limit(20).get()
    return { success: true, list: result.data || [] }
  }

  if (action === 'verify') {
    const proposalId = String(event.proposalId || '')
    if (!proposalId) return { success: false, allowed: false, error: '缺少 Proposal 信息' }
    const result = await db.collection('feature_proposals').doc(proposalId).get()
    const proposal = result.data
    if (!proposal) return { success: false, allowed: false, error: 'Proposal 不存在' }
    const allowed = proposal.submitterOpenId === OPENID && proposal.status === 'approved'
    return { success: true, allowed, proposal: allowed ? proposal : null, error: allowed ? '' : '该 Proposal 尚未通过审核或不属于当前账号' }
  }

  return { success: false, allowed: false, error: '未知操作' }
}
