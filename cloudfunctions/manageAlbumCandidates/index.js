const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'
  if (action === 'upsert') return upsert(event.candidates || [])
  if (!(await isAdmin(OPENID))) return { success: false, error: 'unauthorized' }
  if (action === 'list') return list(event.status || 'pending')
  if (action === 'decide') return decide(event.id, event.decision, OPENID)
  if (action === 'batchDecide') return batchDecide(event.ids || [], event.decision, OPENID)
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

async function batchDecide(ids, decision, openId) {
  const uniqueIds = Array.from(new Set((Array.isArray(ids) ? ids : []).map(x => String(x || '').trim()).filter(Boolean))).slice(0, 100)
  if (!uniqueIds.length) return { success: false, error: '请选择至少一张专辑' }
  if (!['keep', 'delete', 'approve', 'decline'].includes(decision)) return { success: false, error: 'invalid decision' }
  let succeeded = 0
  const errors = []
  for (const id of uniqueIds) {
    try {
      const result = await decide(id, decision, openId)
      if (result && result.success) succeeded += 1
      else errors.push({ id, error: result && result.error ? result.error : '操作失败' })
    } catch (e) {
      errors.push({ id, error: String(e && (e.message || e.errMsg) || e) })
    }
  }
  return { success: errors.length === 0, partial: succeeded > 0 && errors.length > 0, succeeded, failed: errors.length, errors }
}

async function decide(id, decision, openId) {
  if (!id || !['keep', 'delete', 'approve', 'decline'].includes(decision)) return { success: false, error: 'invalid decision' }
  const normalized = decision === 'approve' ? 'keep' : decision === 'decline' ? 'delete' : decision
  const doc = await db.collection('album_candidates').doc(id).get()
  const candidate = doc.data
  if (!candidate) return { success: false, error: 'candidate not found' }

  const originalId = candidate.albumOriginalId || candidate.originalAlbumId || ''
  if (normalized === 'keep') {
    if (originalId) {
      await db.collection('albums').doc(originalId).update({ data: {
        approved: true,
        movedToCandidate: false,
        restoredFromCandidateAt: db.serverDate(),
        restoredFromCandidateBy: openId,
      } })
    } else if (candidate.sourceId) {
      const exists = await db.collection('albums').where({ sourceId: String(candidate.sourceId) }).limit(1).get()
      if (exists.data.length) {
        await db.collection('albums').doc(exists.data[0]._id).update({ data: { approved: true, movedToCandidate: false, restoredFromCandidateAt: db.serverDate(), restoredFromCandidateBy: openId } })
      } else {
        const { _id, status, addedAt, decidedAt, albumOriginalId, originalAlbumId, reportReason, reportSource, reportedBy, movedFromAlbumsAt, ...album } = candidate
        await db.collection('albums').add({ data: { ...album, approved: true, restoredFromCandidateAt: db.serverDate(), restoredFromCandidateBy: openId } })
      }
    }
  }

  if (normalized === 'delete') {
    if (originalId) {
      try { await db.collection('albums').doc(originalId).remove() } catch (e) { await db.collection('albums').doc(originalId).update({ data: { approved: false, deletedByAdmin: true, deletedAt: db.serverDate(), deletedBy: openId } }) }
    } else if (candidate.sourceId) {
      const exists = await db.collection('albums').where({ sourceId: String(candidate.sourceId) }).limit(20).get()
      for (const a of exists.data || []) {
        try { await db.collection('albums').doc(a._id).remove() } catch (e) { await db.collection('albums').doc(a._id).update({ data: { approved: false, deletedByAdmin: true, deletedAt: db.serverDate(), deletedBy: openId } }) }
      }
    }
  }

  await db.collection('album_candidates').doc(id).update({ data: {
    status: normalized === 'keep' ? 'kept' : 'deleted',
    decision: normalized,
    decidedAt: db.serverDate(),
    decidedBy: openId,
  } })
  return { success: true }
}
