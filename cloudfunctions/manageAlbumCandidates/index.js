const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'
  if (action === 'upsert') return upsert(event.candidates || [])
  if (!(await isAdmin(OPENID))) return { success: false, error: 'unauthorized' }
  if (action === 'list') return list(event.status || 'pending')
  if (action === 'decide') return decide(event.id, event.decision)
  if (action === 'stats') return stats()
  return { success: false, error: 'unknown action' }
}

async function isAdmin(openId) {
  if (!openId) return false
  const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
  return r.data.length > 0
}

async function upsert(candidates) {
  let inserted = 0
  for (const item of candidates) {
    if (!item.sourceId) continue
    const found = await db.collection('album_candidates').where({ sourceId: String(item.sourceId) }).limit(1).get()
    if (found.data.length) continue
    await db.collection('album_candidates').add({ data: { ...item, sourceId: String(item.sourceId), status: 'pending', addedAt: db.serverDate(), decidedAt: null } })
    inserted += 1
  }
  return { success: true, inserted }
}

async function list(status) {
  const r = await db.collection('album_candidates').where({ status }).orderBy('addedAt', 'desc').limit(100).get()
  return { success: true, list: r.data, total: r.data.length }
}

async function stats() {
  const r = await db.collection('album_candidates').where({ status: 'pending' }).count()
  return { success: true, pending: r.total }
}

async function decide(id, decision) {
  if (!id || !['approve', 'decline'].includes(decision)) return { success: false, error: 'invalid decision' }
  const doc = await db.collection('album_candidates').doc(id).get()
  const candidate = doc.data
  if (decision === 'approve') {
    const exists = await db.collection('albums').where({ sourceId: candidate.sourceId }).limit(1).get()
    if (!exists.data.length) {
      const { _id, status, addedAt, decidedAt, ...album } = candidate
      await db.collection('albums').add({ data: { ...album, approved: false } })
    }
  }
  await db.collection('album_candidates').doc(id).update({ data: { status: decision === 'approve' ? 'approved' : 'declined', decidedAt: db.serverDate() } })
  return { success: true }
}
