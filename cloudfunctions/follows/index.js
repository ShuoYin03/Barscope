const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const COL = 'follows'

function followDocId(followerOpenId, followingOpenId) {
  return `${followerOpenId}_${followingOpenId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, error: '请先登录' }
  const action = event.action || ''
  const targetOpenId = String(event.openId || '')
  try {
    if (action === 'toggle') return toggle(OPENID, targetOpenId)
    if (action === 'status') return status(OPENID, targetOpenId)
    if (action === 'followers') return listFollowers(targetOpenId, OPENID)
    return { success: false, error: 'unknown action' }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

async function toggle(followerOpenId, targetOpenId) {
  if (!targetOpenId) return { success: false, error: '缺少用户 ID' }
  if (targetOpenId === followerOpenId) return { success: false, error: '不能关注自己' }
  await ensureCollection(COL)
  const id = followDocId(followerOpenId, targetOpenId)
  const existing = await db.collection(COL).doc(id).get().catch(() => ({ data: null }))
  if (existing && existing.data) {
    await db.collection(COL).doc(id).remove()
    return { success: true, following: false }
  }
  await db.collection(COL).doc(id).set({
    data: { followerOpenId, followingOpenId: targetOpenId, createdAt: db.serverDate() },
  })
  return { success: true, following: true }
}

async function status(followerOpenId, targetOpenId) {
  if (!targetOpenId) return { success: false, error: '缺少用户 ID' }
  await ensureCollection(COL)
  const doc = await db.collection(COL).doc(followDocId(followerOpenId, targetOpenId)).get().catch(() => ({ data: null }))
  return { success: true, following: !!(doc && doc.data) }
}

async function listFollowers(targetOpenId, viewerOpenId) {
  if (!targetOpenId) return { success: false, error: '缺少用户 ID' }
  await ensureCollection(COL)
  const followRes = await db.collection(COL).where({ followingOpenId: targetOpenId }).orderBy('createdAt', 'desc').limit(200).get()
  const followerIds = (followRes.data || []).map(x => x.followerOpenId)
  if (!followerIds.length) return { success: true, list: [] }

  const usersRes = await db.collection('users').where({ openId: _.in(followerIds) }).field({ openId: true, nickName: true, avatarUrl: true, type: true }).get()
  const userMap = new Map((usersRes.data || []).map(u => [u.openId, u]))

  let viewerFollowingSet = new Set()
  if (viewerOpenId) {
    const viewerFollowsRes = await db.collection(COL).where({ followerOpenId: viewerOpenId, followingOpenId: _.in(followerIds) }).field({ followingOpenId: true }).get()
    viewerFollowingSet = new Set((viewerFollowsRes.data || []).map(x => x.followingOpenId))
  }

  const list = followerIds.map(id => {
    const u = userMap.get(id)
    if (!u) return null
    return { openId: id, nickName: u.nickName || '匿名用户', avatarUrl: u.avatarUrl || '', type: u.type || 'normal', isFollowing: viewerFollowingSet.has(id) }
  }).filter(Boolean)

  return { success: true, list }
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
