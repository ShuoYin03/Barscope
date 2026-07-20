const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// Reuse a collection that already exists in every current BarScope environment.
// Stat rows use a reserved featureId prefix, so manageFeaturePlaylists' normal
// `.where({ featureId: '2026-h1-top-50-tracks' })` queries never see them.
const COLLECTION = 'feature_playlist_submissions'
const STATS_PREFIX = '__feature_stats__:'

function emptyStats(featureId) {
  return {
    featureId,
    viewCount: 0,
    shareCount: 0,
    recentViewCount: 0,
    recentShareCount: 0,
  }
}

function statsDocId(featureId) {
  // CloudBase document ids are happiest with a conservative character set.
  return `feature_stats_${String(featureId || '').replace(/[^A-Za-z0-9_-]/g, '_')}`
}

async function getOne(featureId) {
  try {
    const res = await db.collection(COLLECTION).doc(statsDocId(featureId)).get()
    const row = res.data || {}
    return {
      ...emptyStats(featureId),
      viewCount: Number(row.viewCount || 0),
      shareCount: Number(row.shareCount || 0),
      recentViewCount: Number(row.recentViewCount || 0),
      recentShareCount: Number(row.recentShareCount || 0),
    }
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
  const ref = db.collection(COLLECTION).doc(statsDocId(featureId))

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
    // The backing collection already exists; only the stat row may be missing.
    await ref.set({
      data: {
        statsRecord: true,
        featureId: `${STATS_PREFIX}${featureId}`,
        metricFeatureId: featureId,
        ...emptyStats(featureId),
        [field]: 1,
        [recentField]: 1,
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

  return getOne(featureId)
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
      return { success: true, list }
    }

    return { success: false, error: 'unknown_action' }
  } catch (e) {
    console.error('[manageFeatureStats]', action, e)
    return { success: false, error: e.message || 'feature_stats_failed' }
  }
}
