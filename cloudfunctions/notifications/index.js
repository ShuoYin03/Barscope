const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COL = 'notifications'

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, error: '请先登录' }
  const action = event.action || 'list'
  try {
    if (action === 'list') return list(OPENID)
    if (action === 'stats') return stats(OPENID)
    if (action === 'markRead') return markRead(String(event.id || ''), OPENID)
    if (action === 'markAllRead') return markAllRead(OPENID)
    return { success: false, error: 'unknown action' }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

async function list(openId) {
  await ensureCollection(COL)
  const r = await db.collection(COL).where({ recipientOpenId: openId }).orderBy('createdAt', 'desc').limit(50).get()
  const list = (r.data || []).map(item => ({ ...item, timeAgo: formatTimeAgo(item.createdAt) }))
  return { success: true, list }
}

async function stats(openId) {
  try {
    const r = await db.collection(COL).where({ recipientOpenId: openId, read: false }).count()
    return { success: true, unread: r.total }
  } catch (e) {
    if (isCollectionMissing(e)) return { success: true, unread: 0 }
    throw e
  }
}

async function markRead(id, openId) {
  if (!id) return { success: false, error: '缺少通知 ID' }
  const doc = await db.collection(COL).doc(id).get().catch(() => null)
  if (!doc || !doc.data || doc.data.recipientOpenId !== openId) return { success: false, error: '通知不存在' }
  await db.collection(COL).doc(id).update({ data: { read: true } })
  return { success: true }
}

async function markAllRead(openId) {
  try {
    await db.collection(COL).where({ recipientOpenId: openId, read: false }).update({ data: { read: true } })
  } catch (e) {
    if (!isCollectionMissing(e)) throw e
  }
  return { success: true }
}

async function ensureCollection(name) {
  try { await db.collection(name).limit(1).get() }
  catch (e) {
    if (!isCollectionMissing(e)) throw e
    try { await db.createCollection(name) } catch (x) {
      if (!String(x && (x.errMsg || x.message) || '').includes('already exists')) throw x
    }
  }
}

function isCollectionMissing(e) {
  const msg = String(e && (e.errMsg || e.message) || '')
  return msg.includes('DATABASE_COLLECTION_NOT_EXIST') || msg.includes('collection not exists') || msg.includes('Db or Table not exist')
}

function formatTimeAgo(date) {
  if (!date) return ''
  const diff = Date.now() - new Date(date).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return days + '天前'
  if (days < 30) return Math.floor(days / 7) + '周前'
  return Math.floor(days / 30) + '个月前'
}
