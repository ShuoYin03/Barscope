const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const COL = 'crawlerStatus'
const DOC = 'singleton'
const INTERNAL_TOKEN = 'cc_internal_v1'

exports.main = async (event, context) => {
  try {
    let status
    try { status = (await db.collection(COL).doc(DOC).get()).data } catch (e) { status = {} }
    if (status && (status.status === 'running' || status.status === 'pending')) {
      return { success: true, skipped: true, reason: `已有任务在跑（${status.status}），本次定时跳过` }
    }

    const res = await cloud.callFunction({
      name: 'cloudCrawler',
      data: { action: 'allApproved', cursor: 0, __internal: true, __token: INTERNAL_TOKEN },
    })
    return { success: true, triggered: true, result: res.result }
  } catch (e) {
    return { success: false, error: e.message }
  }
}
