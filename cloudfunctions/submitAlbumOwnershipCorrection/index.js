const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COL = 'album_ownership_corrections'

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success:false, error:'请先登录' }
  const albumId = String(event.albumId || '').trim()
  const reason = String(event.reason || '').trim().slice(0, 200)
  const rawTargets = Array.isArray(event.targetArtists) && event.targetArtists.length
    ? event.targetArtists
    : [{ artistId:event.targetArtistId, artistName:event.targetArtistName }]
  if (!albumId) return { success:false, error:'缺少专辑ID' }
  if (!rawTargets.length) return { success:false, error:'请至少选择一位 rapper' }

  await ensureCollection(COL)
  const album = (await db.collection('albums').doc(albumId).get()).data
  if (!album) return { success:false, error:'专辑不存在' }

  const approved = await db.collection('artist_candidates').where({ status:'approved' }).field({ artistId:true, artistName:true, avatarUrl:true, picUrl:true }).limit(1000).get()
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[·._-]/g, '')
  const candidates = (approved.data || []).filter(a => a.artistId && a.artistName)
  const resolved = []
  const seen = new Set()
  for (const raw of rawTargets) {
    const targetId = String(raw && raw.artistId || '').trim()
    const targetName = String(raw && raw.artistName || '').trim()
    const targetNorm = norm(targetName)
    const byId = targetId ? candidates.find(a => String(a.artistId) === targetId) : null
    const exact = targetName ? candidates.find(a => norm(a.artistName) === targetNorm) : null
    const fuzzy = byId || exact || (targetName ? candidates.find(a => norm(a.artistName).includes(targetNorm) || targetNorm.includes(norm(a.artistName))) : null)
    if (!fuzzy) return { success:false, error:`未在已批准 rapper 中找到：${targetName || targetId}` }
    const id = String(fuzzy.artistId)
    if (seen.has(id)) continue
    seen.add(id)
    resolved.push({ artistId:id, artistName:String(fuzzy.artistName), avatarUrl:String(fuzzy.avatarUrl || fuzzy.picUrl || '') })
  }
  if (!resolved.length) return { success:false, error:'请至少选择一位 rapper' }

  const signature = resolved.map(x => x.artistId).sort().join('|')
  const exists = await safeFindPending(albumId, signature)
  if (exists.length) return { success:true, existed:true, targetArtistNames:resolved.map(x=>x.artistName) }

  await db.collection(COL).add({ data:{
    albumId,
    albumSourceId:String(album.sourceId || ''),
    albumTitle:String(album.title || ''),
    albumCoverUrl:String(album.coverUrl || ''),
    currentArtist:String(album.artist || ''),
    currentPrimaryArtist:String(album.primaryArtist || ''),
    currentArtistIds:Array.isArray(album.artistIds) ? album.artistIds : [],
    currentNeteaseArtistId:String(album.neteaseArtistId || ''),
    targetArtists:resolved,
    targetArtistIds:resolved.map(x=>x.artistId),
    targetArtistNames:resolved.map(x=>x.artistName),
    targetSignature:signature,
    targetArtistId:resolved[0].artistId,
    targetArtistName:resolved[0].artistName,
    targetAvatarUrl:resolved[0].avatarUrl,
    reason:reason || '用户认为该专辑歌手归属错误或不完整',
    status:'pending',
    submittedBy:OPENID,
    submittedAt:db.serverDate(),
    decidedAt:null,
  } })
  return { success:true, targetArtistNames:resolved.map(x=>x.artistName) }
}

async function safeFindPending(albumId, targetSignature) {
  try {
    const r = await db.collection(COL).where({ albumId, targetSignature, status:'pending' }).limit(1).get()
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