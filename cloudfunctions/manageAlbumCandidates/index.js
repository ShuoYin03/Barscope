const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'
  if (action === 'upsert') return upsert(event.candidates || [], !!event.dryRun)
  if (!(await isAdmin(OPENID))) return { success: false, error: 'unauthorized' }
  if (action === 'list') return list(event.status || 'pending')
  if (action === 'listHidden') return listHidden()
  if (action === 'listLegacyHidden') return listLegacyHidden()
  if (action === 'setHiddenState') return setHiddenState(event.albumId, !!event.approved, OPENID)
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

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\-_·•:：()（）\[\]【】'"“”‘’]/g, '')
}

function platformOf(item) {
  return String(item.sourcePlatform || item.source || 'netease').trim().toLowerCase() || 'netease'
}

function sourceKeyOf(item) {
  const sourceId = String(item.sourceId || '').trim()
  return String(item.sourceKey || `${platformOf(item)}:${sourceId}`).trim()
}

async function findExistingCandidate(item) {
  const sourceKey = sourceKeyOf(item)
  if (sourceKey) {
    const byKey = await db.collection('album_candidates').where({ sourceKey }).limit(1).get()
    if (byKey.data.length) return byKey.data[0]
  }
  const sourceId = String(item.sourceId || '').trim()
  if (!sourceId) return null
  const source = platformOf(item)
  const legacy = await db.collection('album_candidates').where({ sourceId, source }).limit(1).get()
  return legacy.data[0] || null
}

async function findExistingAlbum(item) {
  const sourceKey = sourceKeyOf(item)
  if (sourceKey) {
    const byKey = await db.collection('albums').where({ sourceKey }).limit(1).get()
    if (byKey.data.length) return byKey.data[0]
  }

  if (platformOf(item) === 'qq' && item.qqAlbumMid) {
    const byMid = await db.collection('albums').where({ qqAlbumMid: String(item.qqAlbumMid) }).limit(1).get()
    if (byMid.data.length) return byMid.data[0]
  }

  const sourceId = String(item.sourceId || '').trim()
  const source = platformOf(item)
  if (sourceId) {
    const direct = await db.collection('albums').where({ sourceId, source }).limit(1).get()
    if (direct.data.length) return direct.data[0]
  }

  // Cross-platform album identity: same normalized title + mapped NetEase artist, release year
  // permitting when both sides have one. QQ's album endpoints frequently omit release dates
  // entirely (see build_candidate() in sync_qq_album_candidates.py) — requiring an exact year match
  // would silently skip this check for exactly those albums and let real duplicates through as
  // "new" pending candidates instead of being recognized as already in the catalog.
  const normalizedTitle = normalizeTitle(item.title)
  const neteaseArtistId = String(item.neteaseArtistId || '').trim()
  const releaseYear = Number(item.releaseYear || 0)
  if (normalizedTitle && neteaseArtistId) {
    const query = releaseYear ? { neteaseArtistId, releaseYear } : { neteaseArtistId }
    const candidates = await db.collection('albums')
      .where(query)
      .limit(100)
      .get()
    const hit = (candidates.data || []).find(album => normalizeTitle(album.title) === normalizedTitle)
    if (hit) return hit
  }
  return null
}

async function attachQQIdentity(album, item) {
  if (!album || platformOf(item) !== 'qq') return
  const patch = {}
  if (item.qqAlbumMid && !album.qqAlbumMid) patch.qqAlbumMid = String(item.qqAlbumMid)
  if (item.qqAlbumId && !album.qqAlbumId) patch.qqAlbumId = String(item.qqAlbumId)
  if (item.qqArtistMid && !album.qqArtistMid) patch.qqArtistMid = String(item.qqArtistMid)
  if (Object.keys(patch).length) await db.collection('albums').doc(album._id).update({ data: patch })
}

// dryRun runs the exact same existing-candidate/existing-album lookups upsert would use to
// decide insert-vs-skip-vs-attach, without writing anything — lets a caller preview real
// server-side dedup counts (not just the crawler's own pre-dedup rule filter) before committing.
async function upsert(candidates, dryRun) {
  let inserted = 0
  let skipped = 0
  let matchedExisting = 0
  let errors = 0
  const matchedExistingSamples = []

  for (const raw of candidates) {
    try {
      if (!raw.sourceId) { skipped += 1; continue }
      const source = platformOf(raw)
      const sourceKey = sourceKeyOf(raw)
      const item = {
        ...raw,
        source,
        sourcePlatform: source,
        sourceId: String(raw.sourceId),
        sourceKey,
        normalizedTitle: raw.normalizedTitle || normalizeTitle(raw.title),
      }

      const candidate = await findExistingCandidate(item)
      if (candidate) { skipped += 1; continue }

      const album = await findExistingAlbum(item)
      if (album) {
        if (!dryRun) await attachQQIdentity(album, item)
        matchedExisting += 1
        if (matchedExistingSamples.length < 30) matchedExistingSamples.push({ title: item.title, artist: item.artist, existingAlbumId: album._id, existingTitle: album.title })
        continue
      }

      if (!dryRun) {
        await db.collection('album_candidates').add({
          data: {
            ...item,
            status: 'pending',
            addedAt: db.serverDate(),
            decidedAt: null,
          },
        })
      }
      inserted += 1
    } catch (e) {
      errors += 1
    }
  }
  return { success: errors === 0, dryRun: !!dryRun, inserted, skipped, matchedExisting, errors, matchedExistingSamples }
}

async function list(status) {
  const r = await db.collection('album_candidates').where({ status }).orderBy('addedAt', 'desc').limit(100).get()
  return { success: true, list: r.data, total: r.data.length }
}

async function listHidden() {
  const where = { approved: false, hiddenByAdmin: true }
  const [countRes, listRes] = await Promise.all([
    db.collection('albums').where(where).count(),
    db.collection('albums').where(where).orderBy('hiddenAt', 'desc').limit(100).get(),
  ])
  const list = (listRes.data || []).map(album => ({ ...album, hiddenReason: album.hiddenReason || '管理员从专辑管理中隐藏' }))
  return { success: true, list, total: countRes.total }
}

async function listLegacyHidden() {
  const countRes = await db.collection('albums').where({ approved: false }).count()
  const totalRaw = Number(countRes.total || 0)
  const rows = []
  for (let offset = 0; offset < totalRaw; offset += 100) {
    const r = await db.collection('albums').where({ approved: false }).skip(offset).limit(100).get()
    rows.push(...(r.data || []))
  }
  const list = rows
    .filter(album => album.hiddenByAdmin !== true && album.deletedByAdmin !== true)
    .sort((a, b) => Number(b.releaseYear || 0) - Number(a.releaseYear || 0))
    .map(album => ({ ...album, hiddenReason: album.hiddenReason || album.candidateReason || '历史未显示，来源待确认' }))
  return { success: true, list: list.slice(0, 100), total: list.length }
}

async function stats() {
  const [pending, hidden, legacy] = await Promise.all([
    db.collection('album_candidates').where({ status: 'pending' }).count(),
    db.collection('albums').where({ approved: false, hiddenByAdmin: true }).count(),
    listLegacyHidden(),
  ])
  return { success: true, pending: pending.total, hidden: hidden.total, legacyHidden: legacy.total }
}

async function setHiddenState(albumId, approved, openId) {
  if (!albumId) return { success: false, error: 'albumId required' }
  const doc = await db.collection('albums').doc(albumId).get()
  if (!doc.data) return { success: false, error: 'album not found' }
  const data = approved ? {
    approved: true,
    hiddenByAdmin: _.remove(), hiddenAt: _.remove(), hiddenBy: _.remove(), hiddenReason: _.remove(),
  } : {
    approved: false, hiddenByAdmin: true, hiddenAt: db.serverDate(), hiddenBy: openId,
    hiddenReason: '管理员从专辑管理中隐藏',
  }
  await db.collection('albums').doc(albumId).update({ data })
  return { success: true, approved }
}

async function batchDecide(ids, decision, openId) { return runBatch(ids, id => decide(id, decision, openId)) }
async function batchDecideHidden(ids, decision, openId) { return runBatch(ids, id => decideHidden(id, decision, openId)) }

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
      else errors.push({ id, error: result.status === 'rejected' ? String(result.reason?.message || result.reason) : String(result.value?.error || '操作失败') })
    })
  }
  return { success: errors.length === 0, partial: succeeded > 0 && errors.length > 0, succeeded, failed: errors.length, errors }
}

async function decideHidden(id, decision, openId) {
  if (!id || !['keep', 'delete', 'show', 'mark'].includes(decision)) return { success: false, error: 'invalid decision' }
  const doc = await db.collection('albums').doc(id).get()
  if (!doc.data) return { success: false, error: 'album not found' }
  if (decision === 'mark') {
    await setHiddenState(id, false, openId)
    return { success: true }
  }
  if (decision === 'keep' || decision === 'show') {
    await setHiddenState(id, true, openId)
    await db.collection('albums').doc(id).update({ data: { movedToCandidate: false, restoredFromHiddenAt: db.serverDate(), restoredFromHiddenBy: openId } })
    return { success: true }
  }
  await recordDeletedAlbum(doc.data, openId, '管理员从隐藏专辑列表删除')
  await Promise.all([removeRelated('reviews', 'albumId', id), removeRelated('favorites', 'albumId', id)])
  await db.collection('albums').doc(id).remove()
  return { success: true }
}

async function recordDeletedAlbum(album, openId, reason) {
  if (!album || !album.sourceId) return
  const sourceId = String(album.sourceId)
  const source = platformOf(album)
  const sourceKey = sourceKeyOf({ ...album, source, sourceId })
  let existing = null
  if (sourceKey) {
    const byKey = await db.collection('album_candidates').where({ sourceKey }).limit(1).get()
    existing = byKey.data[0] || null
  }
  if (!existing) {
    const legacy = await db.collection('album_candidates').where({ sourceId, source }).limit(1).get()
    existing = legacy.data[0] || null
  }
  if (existing) {
    await db.collection('album_candidates').doc(existing._id).update({ data: {
      status: 'deleted', decision: 'delete', candidateReason: reason, decidedAt: db.serverDate(), decidedBy: openId,
    } })
    return
  }
  const payload = Object.assign({}, album, {
    source,
    sourcePlatform: source,
    sourceKey,
    albumOriginalId: album._id,
    status: 'deleted',
    decision: 'delete',
    candidateReason: reason,
    reportReason: reason,
    addedAt: db.serverDate(),
    decidedAt: db.serverDate(),
    decidedBy: openId,
  })
  delete payload._id
  await db.collection('album_candidates').add({ data: payload })
}

async function removeRelated(collection, field, value) {
  try { await db.collection(collection).where({ [field]: value }).remove() }
  catch (e) {
    const r = await db.collection(collection).where({ [field]: value }).limit(100).get()
    await Promise.all((r.data || []).map(item => db.collection(collection).doc(item._id).remove().catch(() => {})))
  }
}

const PINYIN_STARTS = [['A','阿'],['B','芭'],['C','嚓'],['D','搭'],['E','蛾'],['F','发'],['G','噶'],['H','哈'],['J','击'],['K','喀'],['L','垃'],['M','妈'],['N','拿'],['O','哦'],['P','啪'],['Q','期'],['R','然'],['S','撒'],['T','塌'],['W','挖'],['X','昔'],['Y','压'],['Z','匝']]
function pinyinInitial(ch){ let letter='#'; for(const [initial,startChar] of PINYIN_STARTS){ if(ch.localeCompare(startChar,'zh-Hans-CN-u-co-pinyin')>=0)letter=initial; else break } return letter }
function firstLetter(name){ for(const ch of Array.from(String(name||'').trim())){ if(/[A-Za-z]/.test(ch))return ch.toUpperCase(); if(/[一-鿿]/.test(ch))return pinyinInitial(ch) } return '#' }

function albumFromCandidate(candidate, openId) {
  const { _id, status, addedAt, decidedAt, albumOriginalId, originalAlbumId, reportReason, reportSource, reportedBy, movedFromAlbumsAt, decision, decidedBy, candidateReason, ...album } = candidate
  const isMultiArtist = Array.isArray(album.artistIds) && album.artistIds.length > 1
  return { ...album, approved: true, movedToCandidate: false, titleLetter: firstLetter(album.title), isMultiArtist, restoredFromCandidateAt: db.serverDate(), restoredFromCandidateBy: openId }
}

async function findAlbumForDecision(candidate) {
  if (candidate.sourceKey) {
    const byKey = await db.collection('albums').where({ sourceKey: String(candidate.sourceKey) }).limit(1).get()
    if (byKey.data.length) return byKey.data[0]
  }
  if (platformOf(candidate) === 'qq' && candidate.qqAlbumMid) {
    const byMid = await db.collection('albums').where({ qqAlbumMid: String(candidate.qqAlbumMid) }).limit(1).get()
    if (byMid.data.length) return byMid.data[0]
  }
  if (candidate.sourceId) {
    const direct = await db.collection('albums').where({ sourceId: String(candidate.sourceId), source: platformOf(candidate) }).limit(1).get()
    if (direct.data.length) return direct.data[0]
  }
  return null
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
      await db.collection('albums').doc(originalId).update({ data: { approved: true, movedToCandidate: false, hiddenByAdmin: _.remove(), hiddenAt: _.remove(), hiddenBy: _.remove(), hiddenReason: _.remove(), restoredFromCandidateAt: db.serverDate(), restoredFromCandidateBy: openId } })
    } else {
      const exists = await findAlbumForDecision(candidate)
      if (exists) await db.collection('albums').doc(exists._id).update({ data: { approved: true, movedToCandidate: false, hiddenByAdmin: _.remove(), hiddenAt: _.remove(), hiddenBy: _.remove(), hiddenReason: _.remove(), restoredFromCandidateAt: db.serverDate(), restoredFromCandidateBy: openId } })
      else await db.collection('albums').add({ data: albumFromCandidate(candidate, openId) })
    }
  }
  if (normalized === 'delete') {
    if (originalId) {
      await Promise.all([removeRelated('reviews', 'albumId', originalId), removeRelated('favorites', 'albumId', originalId)])
      try { await db.collection('albums').doc(originalId).remove() }
      catch (e) { await db.collection('albums').doc(originalId).update({ data: { approved: false, deletedByAdmin: true, deletedAt: db.serverDate(), deletedBy: openId } }) }
    } else {
      const exists = await findAlbumForDecision(candidate)
      if (exists) {
        await Promise.all([removeRelated('reviews', 'albumId', exists._id), removeRelated('favorites', 'albumId', exists._id)])
        try { await db.collection('albums').doc(exists._id).remove() }
        catch (e) { await db.collection('albums').doc(exists._id).update({ data: { approved: false, deletedByAdmin: true, deletedAt: db.serverDate(), deletedBy: openId } }) }
      }
    }
  }
  await db.collection('album_candidates').doc(id).update({ data: { status: normalized === 'keep' ? 'kept' : 'deleted', decision: normalized, decidedAt: db.serverDate(), decidedBy: openId } })
  return { success: true }
}
