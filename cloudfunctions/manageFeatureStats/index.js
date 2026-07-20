const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// Reuse an existing collection to avoid environment-specific collection creation issues.
// Metric rows are isolated by statsRecord + metricFeatureId and never match playlist queries.
const COLLECTION = 'feature_playlist_submissions'

function emptyStats(featureId) {
  return {
    featureId,
    viewCount: 0,
    shareCount: 0,
    recentViewCount: 0,
    recentShareCount: 0,
  }
}

async function findStatsRow(featureId) {
  const res = await db.collection(COLLECTION)
    .where({ statsRecord: true, metricFeatureId: featureId })
    .limit(1)
    .get()
  return (res.data || [])[0] || null
}

async function getOne(featureId) {
  try {
    const row = await findStatsRow(featureId)
    if (!row) return emptyStats(featureId)
    return {
      ...emptyStats(featureId),
      viewCount: Number(row.viewCount || 0),
      shareCount: Number(row.shareCount || 0),
      recentViewCount: Number(row.recentViewCount || 0),
      recentShareCount: Number(row.recentShareCount || 0),
    }
  } catch (e) {
    console.error('[manageFeatureStats] getOne failed', featureId, e)
    return emptyStats(featureId)
  }
}

async function increment(featureId, type) {
  const now = new Date()
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const field = type === 'share' ? 'shareCount' : 'viewCount'
  const recentField = type === 'share' ? 'recentShareCount' : 'recentViewCount'
  const dailyField = type === 'share' ? 'shares' : 'views'

  const row = await findStatsRow(featureId)
  if (row) {
    await db.collection(COLLECTION).doc(row._id).update({
      data: {
        [field]: _.inc(1),
        [recentField]: _.inc(1),
        updatedAt: db.serverDate(),
        [`daily.${dateKey}.${dailyField}`]: _.inc(1),
      },
    })
  } else {
    await db.collection(COLLECTION).add({
      data: {
        statsRecord: true,
        featureId: '__feature_stats__',
        metricFeatureId: featureId,
        viewCount: type === 'view' ? 1 : 0,
        shareCount: type === 'share' ? 1 : 0,
        recentViewCount: type === 'view' ? 1 : 0,
        recentShareCount: type === 'share' ? 1 : 0,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        daily: {
          [dateKey]: {
            views: type === 'view' ? 1 : 0,
            shares: type === 'share' ? 1 : 0,
          },
        },
      },
    })
  }

  const stats = await getOne(featureId)
  console.log('[manageFeatureStats] incremented', { featureId, type, stats })
  return stats
}

exports.main = async event => {
  const action = String(event.action || 'get_many')

  try {
    if (action === 'track_view' || action === 'track_share') {
      const featureId = String(event.featureId || '').trim()
      if (!featureId) return { success: false, error: 'missing_feature_id' }
      const stats = await increment(featureId, action === 'track_share' ? 'share' : 'view')
      return { success: true, stats }
    }

    if (action === 'get_many') {
      const ids = Array.isArray(event.featureIds) ? event.featureIds.map(String).filter(Boolean) : []
      const list = await Promise.all(ids.map(getOne))
      console.log('[manageFeatureStats] get_many', list)
      return { success: true, list }
    }

    return { success: false, error: 'unknown_action' }
  } catch (e) {
    console.error('[manageFeatureStats]', action, e)
    return { success: false, error: e.message || 'feature_stats_failed' }
  }
}
