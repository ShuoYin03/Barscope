const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const COL = 'crawlerStatus'
const DOC = 'singleton'
const INTERNAL_TOKEN = 'cc_internal_v1'

// 每 5 分钟醒一次（config.json 里配的 timer trigger）。
//
// cloudCrawler 的 allApproved 一次只处理一小批艺人（CHUNK，见 cloudCrawler/index.js）就
// 正常返回，不再自己递归调用下一批——避免整条"处理 662 位艺人"的链条卡在一次同步调用里，
// 撞上函数/网关超时。真正把"处理完一批 → 接着处理下一批 → ... → 全部处理完"串起来的，
// 现在是这个定时器：每次醒来看一眼 crawlerStatus，
//   - 如果上次还没跑完（status='running'，mode='allApproved'），就从 progress.processedArtists
//     记的位置接着调用 cloudCrawler，继续下一批；
//   - 如果上次已经跑完/还没跑过，且距离上次完成超过 ~20 小时，就重新从头（cursor=0）开始一轮，
//     实现"每天一次"的效果，同时避免定时器抖动导致同一天内被重复触发多轮。
exports.main = async (event, context) => {
  try {
    let status
    try { status = (await db.collection(COL).doc(DOC).get()).data } catch (e) { status = {} }
    status = status || {}

    if (status.status === 'running' && status.mode === 'allApproved') {
      const cursor = Number((status.progress && status.progress.processedArtists) || 0)
      const res = await cloud.callFunction({
        name: 'cloudCrawler',
        data: { action: 'allApproved', cursor, __internal: true, __token: INTERNAL_TOKEN },
      })
      await writeReport('continued', cursor, res.result)
      return { success: true, continued: true, cursor, result: res.result }
    }

    if (status.status === 'pending') {
      // pending 是 crawlerControl（本地 pipeline.py 那一套）的状态，跟这个云端定时器无关，跳过
      return { success: true, skipped: true, reason: 'pending 状态属于本地爬虫触发流程，本定时器不处理' }
    }

    if (!shouldStartNewRun(status.completedAt)) {
      return { success: true, skipped: true, reason: '距离上次完成不到 20 小时，跳过，等下一次醒来再看' }
    }

    const res = await cloud.callFunction({ name: 'cloudCrawler', data: { action: 'allApproved', cursor: 0, __internal: true, __token: INTERNAL_TOKEN } })
    await writeReport('triggered', 0, res.result)
    return { success: true, triggered: true, result: res.result }
  } catch (e) {
    await safeReportError(e)
    return { success: false, error: e.message }
  }
}

async function writeReport(triggerType, cursor, result) {
  let latest = {}
  try { latest = (await db.collection(COL).doc(DOC).get()).data || {} } catch (e) {}
  const p = latest.progress || {}
  const logs = Array.isArray(latest.log) ? latest.log : (Array.isArray(latest.logs) ? latest.logs.map(x => typeof x === 'string' ? x : x.text || '') : [])
  const now = new Date()
  const reportDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
  await db.collection('crawlerReports').add({ data: {
    reportDate,
    triggerType,
    cursor:Number(cursor || 0),
    status:String(latest.status || ''),
    mode:String(latest.mode || ''),
    totalArtists:Number(p.totalArtists || 0),
    processedArtists:Number(p.processedArtists || 0),
    newAlbums:Number((latest.lastRunSummary || {}).newAlbums || p.albumsFound || 0),
    newCandidates:Number((latest.lastRunSummary || {}).newCandidates || p.candidatesFound || 0),
    logs:logs.slice(0, 30),
    result:result || {},
    createdAt:db.serverDate(),
  } })
}

async function safeReportError(e) {
  try {
    const now = new Date()
    const reportDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
    await db.collection('crawlerReports').add({ data:{ reportDate, triggerType:'error', status:'error', error:e.message, createdAt:db.serverDate() } })
  } catch (x) {}
}

function shouldStartNewRun(completedAt) {
  const ms = toMillis(completedAt)
  if (!ms) return true // 从没跑完过（或读不出时间），直接开始
  const HOURS_20 = 20 * 60 * 60 * 1000
  return Date.now() - ms >= HOURS_20
}

// completedAt 可能是原生 Date、ISO 字符串，或 {$date: 毫秒} 这几种形态之一，都兼容一下
function toMillis(v) {
  if (!v) return 0
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t }
  if (typeof v === 'object' && v.$date) return Number(v.$date) || 0
  return 0
}
