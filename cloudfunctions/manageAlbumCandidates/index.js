const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'
  if (action === 'upsert') return upsert(event.candidates || [])
  if (!(await isAdmin(OPENID))) return { success: false, error: 'unauthorized' }
  if (action === 'list') return list(event.status || 'pending')
  if (action === 'listHidden') return listHidden()
  if (action === 'decide') return decide(event.id, event.decision, OPENID)
  if (action === 'batchDecide') return batchDecide(event.ids || [], event.decision, OPENID)
  if (action === 'decideHidden') return decideHidden(event.id, event.decision, OPENID)
  if (action === 'batchDecideHidden') return batchDecideHidden(event.ids || [], event.decision, OPENID)
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

async function listHidden() {
  const r = await db.collection('albums').where({ approved: false }).limit(100).get()
  const list = (r.data || []).filter(album => !album.deletedByAdmin).map(album => ({
    ...album,
    hiddenReason: album.hiddenReason || album.candidateReason || (album.movedToCandidate ? '已移入专辑审核' : '当前未对用户显示'),
  }))
  return { success: true, list, total: list.length }
}

async function stats() {
  const [pending, hidden] = await Promise.all([
    db.collection('album_candidates').where({ status: 'pending' }).count(),
    db.collection('albums').where({ approved: false }).count(),
  ])
  return { success: true, pending: pending.total, hidden: hidden.total }
}

async function batchDecide(ids, decision, openId) {
  return runBatch(ids, id => decide(id, decision, openId))
}

async function batchDecideHidden(ids, decision, openId) {
  return runBatch(ids, id => decideHidden(id, decision, openId))
}

async function runBatch(ids, handler) {
  const uniqueIds = Array.from(new Set((Array.isArray(ids) ? ids : []).map(x => String(x || '').trim()).filter(Boolean))).slice(0, 100)
  if (!uniqueIds.length) return { success: false, error: '请选择至少一张专辑' }

  let succeeded = 0
  const errors = []
  const concurrency = 8

  for (let i = 0; i < uniqueIds.length; i += concurrency) {
    const chunk = uniqueIds.slice(i, i + concurrency)
    const results = await Promise.allSettled(chunk.map(id => handler(id)))
    results.forEach((result, index) => {
      const id = chunk[index]
      if (result.status === 'fulfilled' && result.value && result.value.success) succeeded += 1
      else {
        const error = result.status === 'rejected'
          ? String(result.reason && (result.reason.message || result.reason.errMsg) || result.reason)
          : String(result.value && result.value.error || '操作失败')
        errors.push({ id, error })
      }
    })
  }

  return { success: errors.length === 0, partial: succeeded > 0 && errors.length > 0, succeeded, failed: errors.length, errors }
}

async function decideHidden(id, decision, openId) {
  if (!id || !['keep', 'delete', 'show'].includes(decision)) return { success: false, error: 'invalid decision' }
  const doc = await db.collection('albums').doc(id).get()
  if (!doc.data) return { success: false, error: 'album not found' }

  if (decision === 'keep' || decision === 'show') {
    await db.collection('albums').doc(id).update({ data: {
      approved: true,
      movedToCandidate: false,
      restoredFromHiddenAt: db.serverDate(),
      restoredFromHiddenBy: openId,
    } })
    return { success: true }
  }

  await Promise.all([
    removeRelated('reviews', 'albumId', id),
    removeRelated('favorites', 'albumId', id),
  ])
  await db.collection('albums').doc(id).remove()
  return { success: true }
}

async function removeRelated(collection, field, value) {
  try {
    await db.collection(collection).where({ [field]: value }).remove()
  } catch (e) {
    console.warn(`bulk remove ${collection} failed`, value, e.message)
    const r = await db.collection(collection).where({ [field]: value }).limit(100).get()
    await Promise.all((r.data || []).map(item => db.collection(collection).doc(item._id).remove().catch(err => {
      console.warn(`remove ${collection} failed`, item._id, err.message)
    })))
  }
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
      await Promise.all([
        removeRelated('reviews', 'albumId', originalId),
        removeRelated('favorites', 'albumId', originalId),
      ])
      try {
        await db.collection('albums').doc(originalId).remove()
      } catch (e) {
        await db.collection('albums').doc(originalId).update({ data: { approved: false, deletedByAdmin: true, deletedAt: db.serverDate(), deletedBy: openId } })
      }
    } else if (candidate.sourceId) {
      const exists = await db.collection('albums').where({ sourceId: String(candidate.sourceId) }).limit(20).get()
      await Promise.all((exists.data || []).map(async a => {
        await Promise.all([
          removeRelated('reviews', 'albumId', a._id),
          removeRelated('favorites', 'albumId', a._id),
        ])
        try {
          await db.collection('albums').doc(a._id).remove()
        } catch (e) {
          await db.collection('albums').doc(a._id).update({ data: { approved: false, deletedByAdmin: true, deletedAt: db.serverDate(), deletedBy: openId } })
        }
      }))
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