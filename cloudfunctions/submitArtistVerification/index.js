const cloud = require('wx-server-sdk')
const { isAdmin } = require('./_shared/auth')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const APPLICATIONS_COL = 'artist_verification_applications'

function clean(value, max) {
  return String(value || '').trim().slice(0, max)
}

async function ensureCollection(name) {
  try {
    await db.collection(name).limit(1).get()
  } catch (e) {
    const msg = String(e && (e.errMsg || e.message) || '')
    if (!msg.includes('DATABASE_COLLECTION_NOT_EXIST') && !msg.includes('collection not exists') && !msg.includes('Db or Table not exist')) throw e
    try { await db.createCollection(name) } catch (x) {}
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'submit'

  if (action === 'getMine') return getMine(OPENID)
  if (action === 'submit') return submit(event, OPENID)

  const admin = await isAdmin(OPENID)
  if (!admin) return { success: false, error: 'unauthorized' }

  if (action === 'list') return list()
  if (action === 'review') return review(event, OPENID)
  if (action === 'stats') return stats()
  return { success: false, error: 'unknown action' }
}

async function getMine(openId) {
  if (!openId) return { success: false, error: '请先登录' }
  await ensureCollection(APPLICATIONS_COL)
  try {
    const result = await db.collection(APPLICATIONS_COL)
      .where({ openId })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get()
    return { success: true, application: result.data[0] || null }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

async function submit(event, openId) {
  if (!openId) return { success: false, error: '请先登录' }
  await ensureCollection(APPLICATIONS_COL)

  const artistId = Number(event.artistId)
  const artistName = clean(event.artistName, 60)
  const artistDocId = clean(event.artistDocId, 60)
  const wechatId = clean(event.wechatId, 80)
  const evidence = clean(event.evidence, 1500)

  if (!artistId || !artistName) return { success: false, error: '请先选择你要认领的艺人' }
  if (!wechatId) return { success: false, error: '请填写微信号' }
  if (evidence.length < 30) return { success: false, error: '请填写至少 30 字的身份证明材料' }

  try {
    const candidateRes = await db.collection('artist_candidates')
      .where({ artistId, status: 'approved' })
      .limit(1)
      .get()
    const candidate = candidateRes.data[0]
    if (!candidate) return { success: false, error: '未找到该艺人' }
    if (candidate.isArtistVerified) return { success: false, error: '该艺人已完成入驻认证' }

    const existingPending = await db.collection(APPLICATIONS_COL)
      .where({ openId, status: 'pending' })
      .limit(1)
      .get()
    if (existingPending.data.length) {
      return { success: false, error: '你已有待审核的入驻申请，请耐心等待' }
    }

    const userRes = await db.collection('users').where({ openId }).limit(1).get()
    const user = userRes.data[0] || {}

    const now = db.serverDate()
    const data = {
      openId,
      nickName: clean(user.nickName || event.nickName, 80),
      avatarUrl: clean(user.avatarUrl || event.avatarUrl, 500),
      artistId,
      artistDocId: artistDocId || candidate._id,
      artistName: candidate.artistName || artistName,
      wechatId,
      evidence,
      status: 'pending',
      adminNote: '',
      createdAt: now,
      updatedAt: now,
      reviewedAt: null,
      reviewedBy: '',
    }

    const result = await db.collection(APPLICATIONS_COL).add({ data })
    return { success: true, id: result._id, status: 'pending' }
  } catch (err) {
    console.error('submitArtistVerification submit failed:', err)
    return { success: false, error: err.message }
  }
}

async function list() {
  await ensureCollection(APPLICATIONS_COL)
  const res = await db.collection(APPLICATIONS_COL).where({ status: 'pending' }).orderBy('createdAt', 'asc').limit(200).get()
  return { success: true, list: res.data || [], total: (res.data || []).length }
}

async function review(event, openId) {
  const applicationId = clean(event.applicationId, 60)
  const decision = String(event.decision || '')
  if (!applicationId || !['approve', 'reject'].includes(decision)) return { success: false, error: 'invalid review request' }

  await ensureCollection(APPLICATIONS_COL)
  const doc = await db.collection(APPLICATIONS_COL).doc(applicationId).get()
  const application = doc.data
  if (!application || application.status !== 'pending') return { success: false, error: '申请已处理或不存在' }

  if (decision === 'approve') {
    const artistDocId = String(application.artistDocId || '')
    if (!artistDocId) return { success: false, error: '缺少艺人记录，无法通过' }
    await db.collection('artist_candidates').doc(artistDocId).update({
      data: {
        isArtistVerified: true,
        verifiedOwnerOpenId: application.openId,
        verifiedAt: db.serverDate(),
      },
    })
  }

  await db.collection(APPLICATIONS_COL).doc(applicationId).update({
    data: {
      status: decision === 'approve' ? 'approved' : 'rejected',
      adminNote: clean(event.adminNote, 300),
      reviewedAt: db.serverDate(),
      reviewedBy: openId,
    },
  })
  return { success: true, decision }
}

async function stats() {
  await ensureCollection(APPLICATIONS_COL)
  const res = await db.collection(APPLICATIONS_COL).where({ status: 'pending' }).count()
  return { success: true, pending: res.total || 0 }
}
