const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  const action = String(event.action || 'list')
  try {
    if (action === 'stats') return stats()
    if (action === 'promote') return promote(event)
    if (action === 'seed') return seed(event)
    return list(event)
  } catch (e) {
    console.error('manageQQAlbumCache failed:', e)
    return { success:false, error:e && e.message ? e.message : 'QQ专辑缓存操作失败' }
  }
}

async function list(event) {
  const keyword = String(event.keyword || '').trim()
  const limit = Math.min(Math.max(Number(event.limit) || 50, 1), 100)
  const res = await db.collection('qq_album_cache').where({ status:'ready' }).orderBy('syncedAt', 'desc').limit(limit).get()
  let rows = res.data || []
  if (keyword) {
    const k = normalize(keyword)
    rows = rows.filter(x => normalize(x.title).includes(k) || normalize(x.artist).includes(k))
  }
  return { success:true, list:rows, count:rows.length }
}

async function stats() {
  const [ready, promoted] = await Promise.all([
    db.collection('qq_album_cache').where({ status:'ready' }).count(),
    db.collection('qq_album_cache').where({ status:'promoted' }).count(),
  ])
  return { success:true, ready:ready.total || 0, promoted:promoted.total || 0 }
}

async function seed(event) {
  const albums = Array.isArray(event.albums) ? event.albums.slice(0,50) : []
  let inserted = 0
  let updated = 0
  let skipped = 0
  for (const album of albums) {
    const sourceId = String(album && (album.qqAlbumMid || album.sourceId) || '').trim()
    if (!sourceId) { skipped++; continue }
    const sourceKey = `qq:${sourceId}`
    const existing = await db.collection('qq_album_cache').where({ sourceKey }).limit(1).get()
    const data = {
      ...album,
      source:'qq',
      sourcePlatform:'qq',
      sourceId,
      sourceKey,
      qqAlbumMid:sourceId,
      status:'ready',
      syncedAt:db.serverDate(),
    }
    delete data._id
    if (existing.data.length) {
      await db.collection('qq_album_cache').doc(existing.data[0]._id).update({ data })
      updated++
    } else {
      await db.collection('qq_album_cache').add({ data })
      inserted++
    }
  }
  return { success:true, inserted, updated, skipped }
}

async function promote(event) {
  const ids = Array.isArray(event.ids) ? event.ids.map(String).filter(Boolean).slice(0,100) : []
  if (!ids.length) return { success:false, error:'请选择要送审的专辑' }
  let promoted = 0
  let skipped = 0
  for (const id of ids) {
    const doc = await db.collection('qq_album_cache').doc(id).get().catch(() => null)
    const row = doc && doc.data
    if (!row || row.status !== 'ready') { skipped++; continue }
    const sourceId = String(row.qqAlbumMid || row.sourceId || '')
    if (!sourceId) { skipped++; continue }
    const exists = await db.collection('album_candidates').where({ sourceKey:`qq:${sourceId}` }).limit(1).get()
    if (exists.data.length) {
      await db.collection('qq_album_cache').doc(id).update({ data:{ status:'promoted', promotedAt:db.serverDate() } })
      skipped++
      continue
    }
    const payload = {
      ...row,
      status:'pending',
      decision:null,
      source:'qq',
      sourcePlatform:'qq',
      sourceId,
      sourceKey:`qq:${sourceId}`,
      submissionMode:'qq-cache',
      reportReason:'QQ音乐同步中心送审',
      reportSource:'qq-sync-center',
      requestSource:'qq-sync-center',
      foundFrom:'QQ音乐同步缓存',
      addedAt:db.serverDate(),
      decidedAt:null,
      decidedBy:null,
    }
    delete payload._id
    delete payload.syncedAt
    await db.collection('album_candidates').add({ data:payload })
    await db.collection('qq_album_cache').doc(id).update({ data:{ status:'promoted', promotedAt:db.serverDate() } })
    promoted++
  }
  return { success:true, promoted, skipped }
}

function normalize(v) {
  return String(v || '').trim().toLowerCase().replace(/explicit/gi,'').replace(/[\s\-_·•.。'"“”‘’()（）\[\]【】/\\?!！？，,:：]+/g,'')
}
