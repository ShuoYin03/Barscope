const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const ids = Array.from(new Set((event.artistIds || []).map(x => String(x)).filter(Boolean))).slice(0, 100)
  if (!ids.length) return { success: true, list: [] }
  try {
    const [profiles, candidates] = await Promise.all([
      db.collection('artists').where({ neteaseArtistId: _.in(ids) }).field({ neteaseArtistId: true, artistId: true, picUrl: true, avatarUrl: true, heroImageUrl: true, backgroundUrl: true, coverUrl: true }).limit(100).get().catch(() => ({ data: [] })),
      db.collection('artist_candidates').where({ artistId: _.in(ids) }).field({ artistId: true, status: true, picUrl: true, avatarUrl: true, heroImageUrl: true, backgroundUrl: true, coverUrl: true }).limit(100).get().catch(() => ({ data: [] })),
    ])

    const map = new Map()
    ;(candidates.data || []).forEach(x => {
      if (x.status === 'approved') map.set(String(x.artistId), x)
    })
    ;(profiles.data || []).forEach(x => {
      const id = String(x.neteaseArtistId || x.artistId)
      map.set(id, { ...(map.get(id) || {}), ...x })
    })

    const list = ids.map(id => {
      const x = map.get(id)
      return {
        artistId: id,
        collected: !!x,
        avatarUrl: x ? (x.avatarUrl || x.picUrl || x.heroImageUrl || x.backgroundUrl || x.coverUrl || '') : '',
      }
    })
    return { success: true, list }
  } catch (e) { return { success: false, error: e.message, list: [] } }
}