const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  const albumId = String(event.albumId || '').trim()
  const reason = String(event.reason || '用户认为该专辑不应收录').trim().slice(0, 200)
  if (!OPENID) return { success:false, error:'请先登录' }
  if (!albumId) return { success:false, error:'缺少专辑ID' }
  try {
    const album = (await db.collection('albums').doc(albumId).get()).data
    if (!album) return { success:false, error:'专辑不存在' }

    const exists = await db.collection('album_candidates').where({ sourceId: album.sourceId || albumId }).limit(1).get()
    const payload = Object.assign({}, album, {
      albumOriginalId: album._id,
      approved: false,
      status: 'pending',
      candidateReason: reason,
      reportReason: reason,
      reportSource: 'album-detail-user-move',
      reportedBy: OPENID,
      movedFromAlbumsAt: db.serverDate(),
      decidedAt: null,
    })
    delete payload._id

    if (exists.data.length) {
      await db.collection('album_candidates').doc(exists.data[0]._id).update({ data: {
        status: 'pending',
        candidateReason: reason,
        reportReason: reason,
        reportSource: 'album-detail-user-move',
        reportedBy: OPENID,
        albumOriginalId: album._id,
        movedFromAlbumsAt: db.serverDate(),
      } })
    } else {
      await db.collection('album_candidates').add({ data: payload })
    }

    await db.collection('albums').doc(albumId).update({ data: {
      approved: false,
      movedToCandidate: true,
      movedToCandidateAt: db.serverDate(),
      movedToCandidateBy: OPENID,
      movedToCandidateReason: reason,
    } })
    return { success:true }
  } catch (e) {
    return { success:false, error:e.message }
  }
}
