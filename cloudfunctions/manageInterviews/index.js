const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const COL = 'interviews'

const CONTENT_MIN_LENGTH = 200
const TITLE_MIN_LENGTH = 2

// Basic content gate — minimum length plus a hardcoded list of common Chinese/English profanity,
// matching the same pattern used by submitReview/moderation.js and the vote features' note filter.
const BAD_WORDS = [
  '傻逼', '傻屄', '煞笔', '沙比', '傻比', 'sb', '智障', '脑残', '弱智', '废物', '人渣', '畜生', '杂种',
  '婊子', '妓女', '贱人', '贱货', '狗娘养的', '死全家', '去死吧', '滚你妈',
  '妈的', '他妈的', 'tmd', 'cnm', 'nmsl', '操你妈', '日你妈', '草你妈', '我操', '我艹',
  'fuck', 'fucker', 'fucking', 'bitch', 'asshole', 'cunt', 'nigger', 'retard',
]
function normalizeForFilter(text) { return String(text || '').toLowerCase().replace(/[\s.,!?~*_\-·、。！？，]/g, '') }
const NORMALIZED_BAD_WORDS = BAD_WORDS.map(normalizeForFilter)
function hasBadWord(text) { const n = normalizeForFilter(text); return NORMALIZED_BAD_WORDS.some(w => w && n.includes(w)) }

async function resolveCloudUrls(urls) {
  const targets = Array.from(new Set(urls.filter(u => typeof u === 'string' && u.startsWith('cloud://'))))
  if (!targets.length) return new Map()
  try {
    const res = await cloud.getTempFileURL({ fileList: targets })
    const map = new Map()
    ;(res.fileList || []).forEach(f => { if (f.status === 0 && f.tempFileURL) map.set(f.fileID, f.tempFileURL) })
    return map
  } catch (e) {
    console.warn('resolveCloudUrls failed:', e.message)
    return new Map()
  }
}
function applyResolvedUrl(url, map) { return (url && map.get(url)) || url }

async function isAdmin(openId) {
  if (!openId) return false
  const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
  return r.data.length > 0
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list_published'

  if (action === 'submit') return submit(event, OPENID)
  if (action === 'get_mine') return getMine(OPENID)
  if (action === 'list_published') return listPublished(event.page || 1, event.pageSize || 20)
  if (action === 'get') return getOne(event.id)

  if (!(await isAdmin(OPENID))) return { success: false, error: 'unauthorized' }
  if (action === 'list_pending') return listPending()
  if (action === 'review') return review(event, OPENID)
  if (action === 'stats') return stats()
  return { success: false, error: 'unknown action' }
}

async function submit(event, OPENID) {
  if (!OPENID) return { success: false, error: '请先登录' }

  const title = String(event.title || '').trim().slice(0, 80)
  const intervieweeName = String(event.intervieweeName || '').trim().slice(0, 40)
  const intro = String(event.intro || '').trim().slice(0, 200)
  const content = String(event.content || '').trim().slice(0, 20000)
  const coverUrl = String(event.coverUrl || '').trim()
  const wechat = String(event.wechat || '').trim().slice(0, 80)

  if (title.length < TITLE_MIN_LENGTH) return { success: false, error: '请填写标题' }
  if (!intervieweeName) return { success: false, error: '请填写受访对象' }
  if (content.length < CONTENT_MIN_LENGTH) return { success: false, error: `正文内容至少需要 ${CONTENT_MIN_LENGTH} 个字` }
  if (hasBadWord(title) || hasBadWord(intro) || hasBadWord(content)) return { success: false, error: '内容包含不当用语，请修改后重新提交' }

  const { data: users } = await db.collection('users').where({ openId: OPENID }).limit(1).get()
  const user = users[0] || {}

  await ensureCollection(COL)

  const pendingRes = await db.collection(COL).where({ submitterOpenId: OPENID, status: 'pending' }).count()
  if ((pendingRes.total || 0) >= 3) return { success: false, error: '你已有 3 篇访谈在审核中，请等待处理后再提交' }

  const doc = {
    title, intervieweeName, intro, content, coverUrl, wechat,
    submitterOpenId: OPENID,
    submitterName: user.nickName || '匿名用户',
    submitterAvatar: user.avatarUrl || '',
    status: 'pending',
    reviewNote: '',
    createdAt: db.serverDate(),
    updatedAt: db.serverDate(),
    publishedAt: null,
  }
  const res = await db.collection(COL).add({ data: doc })
  return { success: true, id: res._id }
}

async function getMine(OPENID) {
  if (!OPENID) return { success: false, error: '请先登录' }
  try {
    const res = await db.collection(COL).where({ submitterOpenId: OPENID }).orderBy('createdAt', 'desc').limit(20).get()
    return { success: true, list: res.data || [] }
  } catch (e) {
    if (isCollectionMissing(e)) return { success: true, list: [] }
    return { success: false, error: e.message }
  }
}

async function listPublished(page, pageSize) {
  try {
    const query = db.collection(COL).where({ status: 'published' })
    const total = Number((await query.count()).total || 0)
    const start = (page - 1) * pageSize
    const result = await query.orderBy('publishedAt', 'desc').skip(start).limit(pageSize)
      .field({ title: true, intervieweeName: true, intro: true, coverUrl: true, submitterName: true, publishedAt: true })
      .get()
    const list = result.data || []
    const urlMap = await resolveCloudUrls(list.map(x => x.coverUrl))
    list.forEach(x => { x.coverUrl = applyResolvedUrl(x.coverUrl, urlMap) })
    return { success: true, list, total, page, pageSize }
  } catch (e) {
    if (isCollectionMissing(e)) return { success: true, list: [], total: 0, page, pageSize }
    return { success: false, error: e.message }
  }
}

async function getOne(id) {
  const docId = String(id || '')
  if (!docId) return { success: false, error: '缺少访谈 ID' }
  try {
    const res = await db.collection(COL).doc(docId).get()
    const doc = res.data
    if (!doc || doc.status !== 'published') return { success: false, error: '访谈不存在或未发布' }
    const urlMap = await resolveCloudUrls([doc.coverUrl])
    doc.coverUrl = applyResolvedUrl(doc.coverUrl, urlMap)
    return { success: true, interview: doc }
  } catch (e) {
    return { success: false, error: '访谈不存在' }
  }
}

async function listPending() {
  try {
    const res = await db.collection(COL).where({ status: 'pending' }).orderBy('createdAt', 'asc').limit(50).get()
    const list = res.data || []
    const urlMap = await resolveCloudUrls(list.map(x => x.coverUrl))
    list.forEach(x => { x.coverUrl = applyResolvedUrl(x.coverUrl, urlMap) })
    return { success: true, list }
  } catch (e) {
    if (isCollectionMissing(e)) return { success: true, list: [] }
    return { success: false, error: e.message }
  }
}

async function review(event, adminOpenId) {
  const id = String(event.id || '')
  const decision = event.decision === 'approve' ? 'approve' : 'reject'
  const reviewNote = String(event.reviewNote || '').trim().slice(0, 200)
  if (!id) return { success: false, error: '缺少访谈 ID' }

  const doc = (await db.collection(COL).doc(id).get()).data
  if (!doc || doc.status !== 'pending') return { success: false, error: '该访谈不在待审核状态' }

  const patch = decision === 'approve'
    ? { status: 'published', publishedAt: db.serverDate(), reviewNote: '', reviewedBy: adminOpenId, updatedAt: db.serverDate() }
    : { status: 'rejected', reviewNote, reviewedBy: adminOpenId, updatedAt: db.serverDate() }

  await db.collection(COL).doc(id).update({ data: patch })
  return { success: true }
}

async function stats() {
  try {
    const r = await db.collection(COL).where({ status: 'pending' }).count()
    return { success: true, pending: r.total || 0 }
  } catch (e) {
    if (isCollectionMissing(e)) return { success: true, pending: 0 }
    return { success: false, error: e.message }
  }
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
