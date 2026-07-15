const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const COL = 'crawlerStatus'
const DOC = 'singleton'
const INTERNAL_TOKEN = 'cc_internal_v1'
// 链条正常时 cloudCrawler 每处理一批都会刷新 lastProgressAt。定时器醒来时若发现最近 CHAIN_ALIVE_MS 内有进度，
// 就认为链还活着、不去插手（避免和链条重复触发同一批）；超过这个时长没进度，则判定链条断了、接力恢复。
const CHAIN_ALIVE_MS = 3 * 60 * 1000
// 距上次完成多久才允许重新开一轮全量。定时器是每小时醒一次的，这里设 50 分钟 → 效果是"每小时做一遍全量"。
// 若想改成"每天一遍"（对网易云更温和），把它改成 20 * 60 * 60 * 1000 即可。
const RECRAWL_COOLDOWN_MS = 50 * 60 * 1000

// 每 5 分钟醒一次（config.json 里配的 timer trigger）。
//
// 一轮全量的"一批接一批处理"现在由 cloudCrawler 自己链式串起来（每批处理完 fire-and-forget 触发下一批，
// 见 cloudCrawler/index.js 的 selfInvokeNext）。这个定时器有两个职责：
//   1) 起步：距上次完成超过 RECRAWL_COOLDOWN_MS（默认 50 分钟）时，从头（cursor=0）调 cloudCrawler
//      把链条点着——配合每 5 分钟的定时器，效果是"每小时一轮全量"（冷却挡住同一小时内的重复起步）；
//   2) 看门狗：如果发现 status='running' 但已超过 CHAIN_ALIVE_MS 没有任何进度（说明某次 fire-and-forget
//      没接上、链断了），就从 progress.processedArtists 记的位置接力恢复；每 5 分钟醒一次意味着断链最多
//      5 分钟内被接回来。链条正常时（最近有进度）则跳过，不去和链条抢着触发同一批。
// pending 状态属于本地 pipeline，与本定时器无关，直接跳过。
exports.main = async (event, context) => {
  try {
    let status
    try { status = (await db.collection(COL).doc(DOC).get()).data } catch (e) { status = {} }
    status = status || {}
    console.log(`[cloudCrawlerDailyTrigger] status=${status.status} mode=${status.mode} completedAt=${JSON.stringify(status.completedAt)} processedArtists=${(status.progress && status.progress.processedArtists) || 0}`)

    if (status.status === 'running' && status.mode === 'allApproved') {
      const cursor = Number((status.progress && status.progress.processedArtists) || 0)
      const idleMs = Date.now() - toMillis(status.lastProgressAt)
      // 链条还活着（最近有进度）→ 定时器不插手，交给 cloudCrawler 自己链式跑，避免重复触发同一批
      if (status.lastProgressAt && idleMs < CHAIN_ALIVE_MS) {
        console.log(`[cloudCrawlerDailyTrigger] branch=skip reason=chain-alive idleMs=${idleMs} cursor=${cursor}`)
        await heartbeat('skip-chain-alive', cursor)
        return { success: true, skipped: true, reason: '链式任务进行中（最近有进度），定时器跳过', cursor }
      }
      // 超过 CHAIN_ALIVE_MS 没有任何进度 → 链条大概率断了（某次 fire-and-forget 没接上）→ 从当前位置接力恢复
      console.log(`[cloudCrawlerDailyTrigger] branch=resume idleMs=${idleMs} cursor=${cursor}`)
      await heartbeat('resume', cursor)
      const res = await cloud.callFunction({
        name: 'cloudCrawler',
        data: { action: 'allApproved', cursor, __internal: true, __token: INTERNAL_TOKEN },
      })
      await writeReport('resumed', cursor, res.result)
      return { success: true, resumed: true, cursor, result: res.result }
    }

    if (status.status === 'pending') {
      // pending 是 crawlerControl（本地 pipeline.py 那一套）的状态，跟这个云端定时器无关，跳过
      console.log('[cloudCrawlerDailyTrigger] branch=skip reason=pending-belongs-to-local-pipeline')
      await heartbeat('skip-pending', 0)
      return { success: true, skipped: true, reason: 'pending 状态属于本地爬虫触发流程，本定时器不处理' }
    }

    if (!shouldStartNewRun(status.completedAt)) {
      console.log('[cloudCrawlerDailyTrigger] branch=skip reason=within-cooldown')
      await heartbeat('skip-cooldown', 0)
      return { success: true, skipped: true, reason: '距离上次完成还在冷却期内，跳过，等下一次醒来再看' }
    }

    console.log('[cloudCrawlerDailyTrigger] branch=start cursor=0')
    await heartbeat('start', 0)
    const res = await cloud.callFunction({ name: 'cloudCrawler', data: { action: 'allApproved', cursor: 0, __internal: true, __token: INTERNAL_TOKEN } })
    await writeReport('triggered', 0, res.result)
    return { success: true, triggered: true, result: res.result }
  } catch (e) {
    console.error('[cloudCrawlerDailyTrigger] failed', e)
    await heartbeat('error', 0, e.message)
    await safeReportError(e)
    return { success: false, error: e.message }
  }
}

// 每次醒来都盖写一次心跳字段（只更新这两个字段，不影响 status/progress 等其它字段），
// 这样即使这一轮什么正事都没做（跳过），也能在数据库/管理页里看出"定时器还在正常醒来"，
// 跟"定时器压根没被云端调用"区分开。
async function heartbeat(branch, cursor, detail) {
  try {
    await db.collection(COL).doc(DOC).update({ data: { lastTriggerAt: db.serverDate(), lastTriggerBranch: branch, lastTriggerCursor: Number(cursor || 0), lastTriggerDetail: detail ? String(detail) : '' } })
  } catch (e) {
    // doc 还不存在（从没跑过一次真正的爬虫）时 update 会失败，忽略即可，等第一次 patchStatus 建好文档后心跳自然能写进去
  }
}

// 写一条运行报告。整体包一层 try/catch：写报告只是次要功能，绝不能因为它失败
// （比如 crawlerReports 集合还没建）就把"爬虫其实已经成功"这件事拖成 failed。
async function writeReport(triggerType, cursor, result) {
  try {
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
  } catch (e) {
    console.warn(`[cloudCrawlerDailyTrigger] writeReport 跳过（不影响主流程）: ${e.message}`)
  }
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
  return Date.now() - ms >= RECRAWL_COOLDOWN_MS
}

// completedAt 可能是原生 Date、ISO 字符串，或 {$date: 毫秒} 这几种形态之一，都兼容一下
function toMillis(v) {
  if (!v) return 0
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t }
  if (typeof v === 'object' && v.$date) return Number(v.$date) || 0
  return 0
}
