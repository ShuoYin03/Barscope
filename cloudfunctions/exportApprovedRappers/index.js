const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

async function isAdmin(openId) {
  if (!openId) return false
  const r = await db.collection('users').where({ openId, type: 'admin' }).limit(1).get()
  return r.data.length > 0
}

exports.main = async () => {
  try {
    const { OPENID: openId } = cloud.getWXContext()
    if (!(await isAdmin(openId))) return { success: false, error: 'unauthorized' }

    const pageSize = 100
    const all = []
    for (let skip = 0; ; skip += pageSize) {
      const r = await db.collection('artist_candidates')
        .where({ status: 'approved' })
        .field({ artistName: true, artistId: true, foundFrom: true, round: true, albumSize: true, fansSize: true })
        .orderBy('round', 'asc')
        .orderBy('fansSize', 'desc')
        .skip(skip)
        .limit(pageSize)
        .get()
      all.push(...r.data)
      if (r.data.length < pageSize) break
    }

    const header = '艺人名\t网易云Artist ID\t来源\t裂变轮次\t专辑数\t粉丝数'
    const rows = all.map(x => [
      x.artistName || '', x.artistId || '', x.foundFrom || '',
      x.round == null ? '' : x.round, x.albumSize || 0, x.fansSize || 0,
    ].join('\t'))
    return { success: true, count: all.length, text: `${header}\n${rows.join('\n')}` }
  } catch (e) {
    return { success: false, error: e.message }
  }
}
