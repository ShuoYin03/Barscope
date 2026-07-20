const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const RELEASE_TYPES = new Set(['LP','Mixtape','Live','Beat Tape',''])

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success:false, error:'请先登录' }
  if (!(await isAdmin(OPENID))) return { success:false, error:'仅管理员可直接修改专辑信息' }

  const albumId = String(event.albumId || '').trim()
  if (!albumId) return { success:false, error:'缺少专辑ID' }

  const releaseType = String(event.releaseType || '').trim()
  if (!RELEASE_TYPES.has(releaseType)) return { success:false, error:'无效的专辑类型' }

  const releaseDate = String(event.releaseDate || '').trim()
  if (releaseDate && !/^\d{4}(?:-\d{2}-\d{2})?$/.test(releaseDate)) return { success:false, error:'发行日期格式应为 YYYY-MM-DD' }

  const patch = {
    coverUrl: String(event.coverUrl || '').trim(),
    releaseDate,
    releaseYear: releaseDate ? Number(releaseDate.slice(0,4)) || 0 : 0,
    company: String(event.company || '').trim(),
    releaseType,
    description: String(event.description || '').trim().slice(0,3000),
    metadataUpdatedBy: OPENID,
    metadataUpdatedAt: db.serverDate(),
  }

  try {
    await db.collection('albums').doc(albumId).get()
    await db.collection('albums').doc(albumId).update({ data:patch })
    return { success:true, patch }
  } catch (e) {
    return { success:false, error:'专辑不存在或修改失败' }
  }
}

async function isAdmin(openId) {
  try {
    const r = await db.collection('users').where({ openId, type:'admin' }).limit(1).get()
    return r.data.length > 0
  } catch (e) { return false }
}