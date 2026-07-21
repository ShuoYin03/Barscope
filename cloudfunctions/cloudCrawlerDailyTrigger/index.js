const cloud = require('wx-server-sdk')
const { isAdmin } = require('./_shared/auth')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// ── 自动每日爬虫的状态机 ─────────────────────────────────────────────────────
// 设计目标：彻底去掉老那套「云函数自己 fire-and-forget 触发下一批」的脆弱链。
// 改成：定时器每 1 分钟醒一次，每次醒来就是一个「tick」，由平台可靠驱动；每个 tick 在时间预算内
// 处理一批艺人后把游标落库就返回。断一次没关系，下一分钟从落库的游标接着跑，不丢不重。
//
// 所有状态放在独立集合 crawlerAutoControl 的单文档里（跟本地 pipeline 用的 crawlerStatus 完全分开，
// 这样本地 pipeline 的 pending 再也冻不住云端自动爬虫）：
//   status        'waiting'(空闲) | 'pending'(有 tick 正在跑，充当互斥锁)
//   lockedAt      变成 pending 的时间 —— 超过 STALE_MS 没解锁就判定上一个 tick 死了、强行接管（防死锁）
//   runDate       本轮属于哪一天（北京时区）；换天则整轮重置
//   cursor        主列表里下一个还没发出去的下标；cursor>=total 且 failedIds 空 = 当天跑完
//   failedIds     失败的艺人 id，下一 tick 优先补跑（不变式：failedIds 里的 id 一定在 cursor 之前）
//   albumsFound/candidatesFound/dated/processedToday  当天累计（展示用）
const AUTO_COL = 'crawlerAutoControl'
const AUTO_DOC = 'singleton'
const INTERNAL_TOKEN = 'cc_internal_v1'

// 一个 tick 内不断取「小撮」艺人 await 调一次 worker，每撮跑完立刻把游标 checkpoint 落库。
// INTAKE_DEADLINE_MS 是「进人窗口」：这段时间内不停取新的小撮；到点后不再开新撮，把在飞的这撮跑完就收尾。
// 微信云函数硬顶 60s（见 reference-wechat-cloud-limits），dailyTrigger 墙钟 ≈ 各次 worker 调用之和 + 写回，
// 所以进人窗口压到 48s，给「末撮跑完 + 收尾写回」留 ~12s 余量。不给单个艺人设限——被杀也不丢，靠 checkpoint 兜底。
const INTAKE_DEADLINE_MS = 48 * 1000
const SUBGROUP = 5                  // 每次 await 调 worker 处理的艺人数（含失败重试）。小撮=更频繁 checkpoint、被杀损失更小
const STALE_MS = 3 * 60 * 1000     // pending 锁超过这个时长没「续命」（无 checkpoint）→ 上个 tick 已死 → 接管
const MAX_FAILED_PER_TICK = 20     // 每 tick 最多重试这么多失败项，避免失败队列很大时把整 tick 耗在重试上、饿死主列表推进

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const action = event && event.action
  try {
    // ── UI 用的两个 action ──
    if (action === 'getAutoStatus') return await getAutoStatus()
    if (action === 'reset') {
      if (!(await isAdmin(OPENID))) return { success: false, error: '无权限' }
      return await resetControl()
    }
    // ── 其余（含定时器触发，event 里没有 action）→ 跑一个 tick ──
    return await runTick()
  } catch (e) {
    console.error('[cloudCrawlerDailyTrigger] failed', e)
    // 出错也要尽量把锁解开，别把 status 卡在 pending
    try { await db.collection(AUTO_COL).doc(AUTO_DOC).update({ data: { status: 'waiting', lockedAt: null, lastTickBranch: 'error', lastError: String(e.message || e) } }) } catch (x) {}
    return { success: false, error: e.message }
  }
}

async function runTick() {
  const ctl = await getControl()
  const now = Date.now()

  // ── 互斥锁 ──
  if (ctl.status === 'pending') {
    const lockedMs = toMillis(ctl.lockedAt)
    if (lockedMs && now - lockedMs < STALE_MS) {
      console.log(`[auto] skip: locked (idle ${now - lockedMs}ms)`)
      await touch('locked-running')
      return { success: true, skipped: true, reason: '上一批仍在运行' }
    }
    console.log('[auto] stale lock → take over')
  }

  const today = todayCN()
  const list = await loadApproved()
  const total = list.length
  const newDay = ctl.runDate !== today

  const cursor = newDay ? 0 : Number(ctl.cursor || 0)
  const failedIds = newDay ? [] : (Array.isArray(ctl.failedIds) ? ctl.failedIds.map(String) : [])
  const base = newDay
    ? { albumsFound: 0, candidatesFound: 0, dated: 0, processedToday: 0, startedAt: db.serverDate() }
    : { albumsFound: Number(ctl.albumsFound || 0), candidatesFound: Number(ctl.candidatesFound || 0), dated: Number(ctl.dated || 0), processedToday: Number(ctl.processedToday || 0), startedAt: ctl.startedAt || db.serverDate() }

  // ── 今天已经跑完了（或没有已批准艺人）→ 保持 waiting，等明天 ──
  if (!total || (cursor >= total && failedIds.length === 0)) {
    const doc = Object.assign(makeControl(), base, {
      runDate: today, cursor: Math.min(cursor, total), failedIds: [], total,
      status: 'waiting', lockedAt: null,
      completedToday: total > 0, lastTickAt: db.serverDate(),
      lastTickBranch: total ? 'done-today' : 'no-artists', lastLog: ctl.lastLog || '',
    })
    // 从「未完成」跨到「完成」的那一次，补写一条当天报告（只写一次）
    if (total && !ctl.completedToday) await writeDailyReport(doc)
    await saveControl(doc)
    await touch(total ? 'auto-idle' : 'no-artists')
    return { success: true, skipped: true, reason: total ? '今日已完成' : '无已批准艺人', cursor, total }
  }

  // ── 上锁 ──（lockToken 是这次 tick 的凭证：每次 checkpoint 前会复查，若期间被「全部重置」或别的 tick 抢占改了 token，就停手，避免把重置/新状态盖掉）
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  await saveControl(Object.assign(makeControl(), base, {
    runDate: today, cursor, failedIds, total,
    status: 'pending', lockedAt: db.serverDate(), lockToken: token, completedToday: false,
    lastTickAt: ctl.lastTickAt || null, lastTickBranch: 'running', lastLog: ctl.lastLog || '', lastError: '',
  }))
  await touch('auto-tick')

  // ── 本 tick 的进人游标与失败队列 ──
  const nameMap = new Map(list.map(x => [x.artistId, x.artistName]))
  const failedPool = failedIds.slice(0, MAX_FAILED_PER_TICK) // 本 tick 只重试这么多失败项（其余保留在队列，下轮再说）
  const remainingFailed = new Set(failedIds)                 // 完整失败队列，边跑边增删，收尾时落库
  let fi = 0                 // failedPool 指针
  let curCursor = cursor     // 主列表指针（绝对下标）
  let accAlbums = base.albumsFound, accCand = base.candidatesFound, accDated = base.dated
  let lastLog = ctl.lastLog || '', lastError = '', processed = 0
  const tickStart = Date.now()

  // ── 循环：取一小撮 → await 调 worker 抓 → 立刻 checkpoint 落库。被杀也只丢最后没 checkpoint 的一撮，且 albums 里已落、幂等可重来 ──
  while (Date.now() - tickStart < INTAKE_DEADLINE_MS) {
    // 组一撮：失败优先，再从主列表接。用 peek（pFi/pCursor），调用成功后才提交，失败则不推进游标
    const sub = [], meta = []
    let pFi = fi, pCursor = curCursor
    while (sub.length < SUBGROUP && pFi < failedPool.length) { const id = failedPool[pFi++]; sub.push({ artistId: id, artistName: nameMap.get(id) || '' }); meta.push({ id, source: 'failed' }) }
    while (sub.length < SUBGROUP && pCursor < total) { const x = list[pCursor++]; sub.push({ artistId: x.artistId, artistName: x.artistName }); meta.push({ id: x.artistId, source: 'main' }) }
    if (sub.length === 0) break // 失败池和主列表都排完了

    let out
    try {
      const res = await cloud.callFunction({ name: 'cloudCrawler', data: { action: 'autoBatch', ids: sub, __internal: true, __token: INTERNAL_TOKEN } })
      out = (res && res.result) || {}
    } catch (e) { out = { success: false, error: e.message } }

    // worker 系统性报错（比如没更新→"未知 action"、或调用超时）→ 不提交这撮、游标不动，记诊断后停手，交给下一 tick
    if (out.success === false) { lastError = String(out.error || 'worker 调用失败'); break }

    // 调用成功 → 提交 peek
    fi = pFi; curCursor = pCursor
    const okSet = new Set((out.succeeded || []).map(String))
    for (const m of meta) {
      if (m.source === 'failed') { if (okSet.has(m.id)) remainingFailed.delete(m.id) /* 又失败则保留 */ }
      else { if (!okSet.has(m.id)) remainingFailed.add(m.id) } // 主列表这位失败 → 进重试队列（它已在游标之前，不会重复）
    }
    accAlbums += Number(out.albumsFound || 0); accCand += Number(out.candidatesFound || 0); accDated += Number(out.dated || 0)
    if (out.lastLog) lastLog = out.lastLog
    processed += sub.length

    // checkpoint：先复查凭证（被重置/抢占就停），再把进度落库；lockedAt 刷新 = 给锁续命，说明这 tick 还活着
    const chk = await getControl()
    if (chk.lockToken !== token) { console.log('[auto] superseded mid-tick, stop'); return { success: true, skipped: true, reason: '本轮被重置/抢占' } }
    await saveControl(Object.assign(makeControl(), {
      runDate: today, cursor: curCursor, failedIds: Array.from(remainingFailed), total,
      albumsFound: accAlbums, candidatesFound: accCand, dated: accDated, processedToday: curCursor, startedAt: base.startedAt,
      status: 'pending', lockedAt: db.serverDate(), lockToken: token, completedToday: false,
      lastTickAt: db.serverDate(), lastTickBranch: 'running', lastLog, lastError: '',
    }))
  }

  // ── 收尾：复查凭证后解锁 + 落最终状态 ──
  const fresh = await getControl()
  if (fresh.lockToken !== token) return { success: true, skipped: true, reason: '本轮被重置/抢占' }

  const nextFailed = Array.from(remainingFailed)
  const doneNow = curCursor >= total && nextFailed.length === 0
  const doc = Object.assign(makeControl(), {
    runDate: today, cursor: curCursor, failedIds: nextFailed, total,
    albumsFound: accAlbums, candidatesFound: accCand, dated: accDated, processedToday: curCursor, startedAt: base.startedAt,
    status: 'waiting', lockedAt: null, lockToken: '', completedToday: doneNow,
    lastTickAt: db.serverDate(), lastTickBranch: lastError ? 'error' : (doneNow ? 'done-today' : 'ran'),
    lastLog, lastError,
  })
  await saveControl(doc)
  if (doneNow) await writeDailyReport(doc)
  await touch(doneNow ? 'auto-done' : 'auto-ran')
  console.log(`[auto] tick done cursor=${curCursor}/${total} failed=${nextFailed.length} processed=${processed} done=${doneNow} err=${lastError}`)
  return { success: true, ran: true, cursor: curCursor, total, failed: nextFailed.length, processed, albumsFound: accAlbums, doneToday: doneNow, lastError }
}

// UI：读当前状态 + 把失败 id 解析成名字（给「失败待补」展开用）
async function getAutoStatus() {
  const ctl = await getControl()
  let failedNames = []
  const ids = Array.isArray(ctl.failedIds) ? ctl.failedIds.map(String) : []
  if (ids.length) {
    try {
      const r = await db.collection('artist_candidates').where({ artistId: db.command.in(ids) }).field({ artistId: true, artistName: true }).limit(1000).get()
      const m = new Map((r.data || []).map(x => [String(x.artistId), x.artistName]))
      failedNames = ids.map(id => m.get(id) || id)
    } catch (e) { failedNames = ids }
  }
  return { success: true, control: ctl, failedNames }
}

// UI：全部重置 —— 指针清零、失败清空，今天从头重跑（下一次定时 tick ≤1 分钟内自动开始）
async function resetControl() {
  const doc = Object.assign(makeControl(), { runDate: todayCN(), startedAt: db.serverDate() })
  await saveControl(doc)
  await touch('auto-reset')
  return { success: true }
}

// 当天跑完时补一条「每日爬虫」历史报告（crawlerReports 里，页面历史列表读它）
async function writeDailyReport(doc) {
  try {
    await db.collection('crawlerReports').add({ data: {
      reportDate: doc.runDate,
      triggerType: 'auto-daily',
      status: 'done',
      totalArtists: Number(doc.total || 0),
      processedArtists: Number(doc.processedToday || 0),
      newAlbums: Number(doc.albumsFound || 0),
      newCandidates: Number(doc.candidatesFound || 0),
      dated: Number(doc.dated || 0),
      failedCount: Array.isArray(doc.failedIds) ? doc.failedIds.length : 0,
      logs: [doc.lastLog || ''].filter(Boolean),
      createdAt: db.serverDate(),
    } })
  } catch (e) { console.warn('[auto] writeDailyReport 跳过:', e.message) }
}

// 顺手在老的 crawlerStatus 上盖一个心跳，让爬虫管理页那个「定时器还活着」的指示继续有意义
async function touch(branch) {
  try { await db.collection('crawlerStatus').doc('singleton').update({ data: { lastTriggerAt: db.serverDate(), lastTriggerBranch: branch } }) } catch (e) {}
}

async function loadApproved() {
  const r = await db.collection('artist_candidates').where({ status: 'approved' }).field({ artistId: true, artistName: true }).limit(1000).get()
  const seen = new Set(); const out = []
  for (const x of (r.data || [])) {
    if (!x.artistId) continue
    const id = String(x.artistId)
    if (seen.has(id)) continue // 去重，保证「failedIds 里的 id 一定在 cursor 之前」这个不变式成立
    seen.add(id); out.push({ artistId: id, artistName: x.artistName || '' })
  }
  return out
}

async function getControl() { try { return (await db.collection(AUTO_COL).doc(AUTO_DOC).get()).data || makeControl() } catch (e) { return makeControl() } }
async function saveControl(doc) { const d = Object.assign({}, doc); delete d._id; await db.collection(AUTO_COL).doc(AUTO_DOC).set({ data: d }) }
function makeControl() { return { _id: AUTO_DOC, status: 'waiting', lockedAt: null, lockToken: '', runDate: '', cursor: 0, total: 0, failedIds: [], albumsFound: 0, candidatesFound: 0, dated: 0, processedToday: 0, startedAt: null, completedToday: false, lastTickAt: null, lastTickBranch: '', lastLog: '', lastError: '' } }

// 北京时间（UTC+8）的 YYYY-MM-DD，凌晨自然换天，符合国内发行时间
function todayCN() { const d = new Date(Date.now() + 8 * 3600 * 1000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` }
function toMillis(v) { if (!v) return 0; if (v instanceof Date) return v.getTime(); if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t } if (typeof v === 'object' && v.$date) return Number(v.$date) || 0; return 0 }
