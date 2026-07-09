const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success:false, error:'请先登录' }
  const albumId = String(event.albumId || '').trim()
  const targetId = String(event.targetArtistId || '').trim()
  const targetName = String(event.targetArtistName || '').trim()
  const reason = String(event.reason || '').trim().slice(0, 200)
  if (!albumId) return { success:false, error:'缺少专辑ID' }
  if (!targetId && !targetName) return { success:false, error:'请选择应归属的 rapper' }

  const album = (await db.collection('albums').doc(albumId).get()).data
  if (!album) return { success:false, error:'专辑不存在' }

  const approved = await db.collection('artist_candidates').where({ status:'approved' }).field({ artistId:true, artistName:true, avatarUrl:true, picUrl:true }).limit(1000).get()
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[·._-]/g, '')
  const targetNorm = norm(targetName)
  const candidates = (approved.data || []).filter(a => a.artistId && a.artistName)
  const byId = targetId ? candidates.find(a => String(a.artistId) === targetId) : null
  const exact = targetName ? candidates.find(a => norm(a.artistName) === targetNorm) : null
  const fuzzy = byId || exact || (targetName ? candidates.find(a => norm(a.artistName).includes(targetNorm) || targetNorm.includes(norm(a.artistName))) : null)
  if (!fuzzy) return { success:false, error:'未在已批准 rapper 中找到该名称，请先提交 rapper 申请或确认拼写' }

  const exists = await db.collection('album_ownership_corrections').where({ albumId, targetArtistId:String(fuzzy.artistId), status:'pending' }).limit(1).get()
  if (exists.data.length) return { success:true, existed:true, targetArtistName:fuzzy.artistName }

  await db.collection('album_ownership_corrections').add({ data:{
    albumId,
    albumSourceId:String(album.sourceId || ''),
    albumTitle:String(album.title || ''),
    albumCoverUrl:String(album.coverUrl || ''),
    currentArtist:String(album.artist || ''),
    currentPrimaryArtist:String(album.primaryArtist || ''),
    currentArtistIds:Array.isArray(album.artistIds) ? album.artistIds : [],
    currentNeteaseArtistId:String(album.neteaseArtistId || ''),
    targetArtistId:String(fuzzy.artistId),
    targetArtistName:String(fuzzy.artistName),
    targetAvatarUrl:String(fuzzy.avatarUrl || fuzzy.picUrl || ''),
    reason:reason || '用户认为该专辑歌手归属错误',
    status:'pending',
    submittedBy:OPENID,
    submittedAt:db.serverDate(),
    decidedAt:null,
  } })
  return { success:true, targetArtistName:fuzzy.artistName }
}
