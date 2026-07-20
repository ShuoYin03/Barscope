const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const COLLECTION = 'feature_stats'

async function ensureCollection() {
  try {
    await db.collection(COLLECTION).limit(1).get()
  } catch (e) {
    try { await db.createCollection(COLLECTION) } catch (_) {}
  }
}

function emptyStats(featureId) {
  return {
    featureId,
    viewCount: 0,
    shareCount: 0,
    recentViewCount: 0,
    recentShareCount: 0,
  }
}

async function getOne(featureId) {
  try {
    const res = await db.collection(COLLECTION).doc(featureId).get()
    return { ...emptyStats(featureId), ...(res.data || {}) }
  } catch (e) {
    return emptyStats(featureId)
  }
}

async function increment(featureId, type) {
  const now = new Date()
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const field = type === 'share' ? 'shareCount' : 'viewCount'
  const recentField = type === 'share' ? 'recentShareCount' : 'recentViewCount'
  const dailyField = type === 'share' ? 'shares' : 'views'
  const ref = db.collection(COLLECTION).doc(featureId)
  try {
    await ref.update({
      data: {
        [field]: _.inc(1),
        [recentField]: _.inc(1),
        updatedAt: db.serverDate(),
        [`daily.${dateKey}.${dailyField}`]: _.inc(1),
      },
    })
  } catch (e) {
    await ref.set({
      data: {
        ...emptyStats(featureId),
        [field]: 1,
        [recentField]: 1,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        daily: { [dateKey]: { views: type === 'view' ? 1 : 0, shares: type === 'share' ? 1 : 0 } },
      },
    })
  }
  return getOne(featureId)
}

exports.main = async event => {
  await ensureCollection()
  const action = String(event.action || 'get_many')
  if (action === 'track_view' || action === 'track_share') {
    const featureId = String(event.featureId || '').trim()
    if (!featureId) return { success: false, error: 'missing_feature_id' }
    const stats = await increment(featureId, action === 'track_share' ? 'share' : 'view')
    return { success: true, stats }
  }
  if (action === 'get_many') {
    const ids = Array.isArray(event.featureIds) ? event.featureIds.map(String).filter(Boolean) : []
    const list = await Promise.all(ids.map(getOne))
    return { success: true, list }
  }
  return { success: false, error: 'unknown_action' }
}
