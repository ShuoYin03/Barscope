const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// Aggressive mode: each call starts 20 NetEase album-detail requests in parallel.
// 80 worked for database-only crawls; 80 external HTTP calls at once is likely to be rate-limited.
const BATCH_SIZE = 20

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve(null) } })
    })
    req.on('error', reject)
    req.setTimeout(1500, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function isAdmin(openId) {
  const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
  return r.data.length > 0
}

function normalizeName(name) {
  return String(name || '')
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
    .replace(/\s*(伴奏|instrumental|inst\.?|off\s*vocal|karaoke|纯音乐|伴奏版|伴奏带)\s*/ig, '')
    .replace(/[\s\-_.·]/g, '')
    .toLowerCase()
}

function inspectTracks(songs) {
  const names = (songs || []).map(s => String(s.name || '').trim()).filter(Boolean)
  const accompaniment = names.filter(n => /[（(【\[]?\s*(伴奏|instrumental|inst\.?|off\s*vocal|karaoke|纯音乐|伴奏版|伴奏带)/i.test(n))
  const normalized = names.map(normalizeName).filter(Boolean)
  const allSame = normalized.length >= 2 && new Set(normalized).size === 1
  if (accompaniment.length) return { bad: true, reason: '含有伴奏/纯音乐版本曲目', example: accompaniment.slice(0, 4) }
  if (allSame) return { bad: true, reason: '全专曲目名称重复', example: names.slice(0, 4) }
  return { bad: false }
}

async function markScreened(id, status) {
  await db.collection('albums').doc(id).update({ data: { qualityScreenedAt: db.serverDate(), qualityScreenStatus: status } })
}

async function processAlbum(album) {
  const sourceId = String(album.sourceId || '')
  if (!/^\d+$/.test(sourceId)) {
    await markScreened(album._id, 'skipped_no_source_id')
    return { checked: 1, moved: 0, failed: 0, skipped: 1 }
  }
  try {
    const data = await httpsGet(`https://music.163.com/api/v1/album/${sourceId}`)
    const songs = data && data.code === 200 && data.songs ? data.songs : []
    if (!songs.length) {
      await markScreened(album._id, 'failed_no_tracks')
      return { checked: 1, moved: 0, failed: 1, skipped: 0 }
    }
    const verdict = inspectTracks(songs)
    if (!verdict.bad) {
      await markScreened(album._id, 'passed')
      return { checked: 1, moved: 0, failed: 0, skipped: 0 }
    }
    const existing = await db.collection('album_candidates').where({ sourceId }).limit(1).get()
    if (!existing.data.length) {
      await db.collection('album_candidates').add({ data: {
        sourceId, title: album.title || '', artist: album.artist || '', primaryArtist: album.primaryArtist || '', neteaseArtistId: album.neteaseArtistId || '', releaseYear: album.releaseYear || 0, releaseDate: album.releaseDate || '', coverUrl: album.coverUrl || '', trackCount: album.trackCount || songs.length, genres: album.genres || [], source: 'netease', crawlSource: 'quality-rescreen', candidateReason: verdict.reason, duplicateTrackExample: verdict.example || [], status: 'pending', addedAt: db.serverDate(), decidedAt: null,
      } })
    }
    await db.collection('albums').doc(album._id).remove()
    return { checked: 1, moved: 1, failed: 0, skipped: 0 }
  } catch (e) {
    await markScreened(album._id, 'failed_request')
    return { checked: 1, moved: 0, failed: 1, skipped: 0 }
  }
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  if (!(await isAdmin(OPENID))) return { success: false, error: '无权限' }
  const query = await db.collection('albums').where({ qualityScreenedAt: _.exists(false) }).field({ _id:true, sourceId:true, title:true, artist:true, primaryArtist:true, neteaseArtistId:true, releaseYear:true, releaseDate:true, coverUrl:true, trackCount:true, genres:true }).limit(BATCH_SIZE).get()
  const albums = query.data || []
  if (!albums.length) return { success: true, checked: 0, moved: 0, failed: 0, skipped: 0, done: true }
  const results = await Promise.all(albums.map(processAlbum))
  const total = results.reduce((acc, item) => ({ checked: acc.checked + item.checked, moved: acc.moved + item.moved, failed: acc.failed + item.failed, skipped: acc.skipped + item.skipped }), { checked: 0, moved: 0, failed: 0, skipped: 0 })
  return { success: true, ...total, done: false }
}
