const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COL = 'album_type_corrections'
const RELEASE_TYPES = new Set(['LP', 'Mixtape', 'Live', 'Beat Tape'])

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success:false, error:'请先登录' }
  const albumId = String(event.albumId || '').trim()
  const releaseType = String(event.releaseType || '').trim()
  const reason = String(event.reason || '').trim().slice(0, 200)
  if (!albumId) return { success:false, error:'缺少专辑ID' }
  if (!RELEASE_TYPES.has(releaseType)) return { success:false, error:'无效的类型' }

  await ensureCollection(COL)
  const album = (await db.collection('albums').doc(albumId).get()).data
  if (!album) return { success:false, error:'专辑不存在' }
  if (String(album.releaseType || '') === releaseType) return { success:false, error:'该专辑已是此类型' }

  const exists = await safeFindPending(albumId, releaseType)
  if (exists.length) return { success:true, existed:true }

  await db.collection(COL).add({ data:{
    albumId,
    albumTitle:String(album.title || ''),
    albumCoverUrl:String(album.coverUrl || ''),
    currentReleaseType:String(album.releaseType || ''),
    targetReleaseType:releaseType,
    reason:reason || '用户认为该专辑类型标注有误',
    status:'pending',
    submittedBy:OPENID,
    submittedAt:db.serverDate(),
    decidedAt:null,
  } })
  return { success:true }
}

async function safeFindPending(albumId, targetReleaseType) {
  try {
    const r = await db.collection(COL).where({ albumId, targetReleaseType, status:'pending' }).limit(1).get()
    return r.data || []
  } catch (e) {
    if (isCollectionMissing(e)) return []
    throw e
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
