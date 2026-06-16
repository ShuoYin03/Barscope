const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db  = cloud.database()
const _   = db.command
const COL = 'crawlerStatus'
const DOC = 'singleton'

const ADMIN_ACTIONS  = new Set(['trigger', 'updateSchedule', 'clearLog'])
const SERVER_ACTIONS = new Set(['claimRun', 'updateProgress', 'appendLog', 'completeRun', 'failRun'])

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { action }  = event

  try {
    // Admin-only actions require OPENID auth
    if (ADMIN_ACTIONS.has(action)) {
      if (!OPENID) return { success: false, error: '无权限' }
      const { data: admins } = await db.collection('users')
        .where({ openId: OPENID, type: 'admin' })
        .limit(1)
        .get()
      if (admins.length === 0) return { success: false, error: '无权限' }
    }

    // ── Read status ────────────────────────────────────────────────────────────
    if (action === 'getStatus') {
      let doc
      try {
        const res = await db.collection(COL).doc(DOC).get()
        doc = res.data
      } catch {
        doc = makeDefault()
      }
      return { success: true, status: doc }
    }

    // ── Admin: trigger a manual run ────────────────────────────────────────────
    if (action === 'trigger') {
      await upsertDoc({
        status:      'pending',
        triggeredAt: db.serverDate(),
        triggerType: 'manual',
        completedAt: null,
      })
      return { success: true }
    }

    // ── Admin: update schedule config ─────────────────────────────────────────
    if (action === 'updateSchedule') {
      const { enabled, interval } = event
      await upsertDoc({ schedule: { enabled: !!enabled, interval: interval || 'weekly', nextRun: null } })
      return { success: true }
    }

    // ── Admin: clear log ──────────────────────────────────────────────────────
    if (action === 'clearLog') {
      await upsertDoc({ log: [] })
      return { success: true }
    }

    // ── Pipeline: claim a pending run ─────────────────────────────────────────
    if (action === 'claimRun') {
      let current
      try { current = (await db.collection(COL).doc(DOC).get()).data }
      catch { current = null }

      if (!current || current.status !== 'pending') {
        return { success: false, error: 'no pending run' }
      }
      await db.collection(COL).doc(DOC).update({
        data: {
          status: 'running',
          progress: { totalArtists: 0, processedArtists: 0, albumsFound: 0, candidatesFound: 0 },
        },
      })
      return { success: true }
    }

    // ── Pipeline: update progress ─────────────────────────────────────────────
    if (action === 'updateProgress') {
      const { totalArtists = 0, processedArtists = 0, albumsFound = 0, candidatesFound = 0 } = event
      await db.collection(COL).doc(DOC).update({
        data: { progress: { totalArtists, processedArtists, albumsFound, candidatesFound } },
      })
      return { success: true }
    }

    // ── Pipeline: append a log line ────────────────────────────────────────────
    if (action === 'appendLog') {
      const { line = '' } = event
      const ts = new Date().toISOString().slice(11, 19)
      await db.collection(COL).doc(DOC).update({
        data: { log: _.push({ each: [`[${ts}] ${line}`], slice: -50 }) },
      })
      return { success: true }
    }

    // ── Pipeline: mark run as complete ────────────────────────────────────────
    if (action === 'completeRun') {
      const { newAlbums = 0, newCandidates = 0, errors = [] } = event
      await db.collection(COL).doc(DOC).update({
        data: {
          status:      'done',
          completedAt: db.serverDate(),
          lastRunSummary: { newAlbums, newCandidates, errors },
        },
      })
      return { success: true }
    }

    // ── Pipeline: mark run as failed ─────────────────────────────────────────
    if (action === 'failRun') {
      const { error = '' } = event
      await db.collection(COL).doc(DOC).update({
        data: {
          status:      'error',
          completedAt: db.serverDate(),
          lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [error] },
        },
      })
      return { success: true }
    }

    return { success: false, error: '未知 action' }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

async function upsertDoc(fields) {
  try {
    await db.collection(COL).doc(DOC).update({ data: fields })
  } catch {
    await db.collection(COL).add({
      data: Object.assign(makeDefault(), { _id: DOC }, fields),
    })
  }
}

function makeDefault() {
  return {
    _id:            DOC,
    status:         'idle',
    triggeredAt:    null,
    completedAt:    null,
    triggerType:    'manual',
    progress:       { totalArtists: 0, processedArtists: 0, albumsFound: 0, candidatesFound: 0 },
    lastRunSummary: { newAlbums: 0, newCandidates: 0, errors: [] },
    schedule:       { enabled: false, interval: 'weekly', nextRun: null },
    log:            [],
  }
}
