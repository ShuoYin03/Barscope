const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function sortList(list, sortBy) {
  const field = sortBy === 'releaseYear' ? 'releaseDate' : 'avgScore'
  const direction = sortBy === 'releaseYear' ? 1 : -1
  return list.slice().sort((a, b) => {
    const av = a[field] || (direction === 1 ? '9999-99-99' : 0)
    const bv = b[field] || (direction === 1 ? '9999-99-99' : 0)
    return direction * (av > bv ? 1 : av < bv ? -1 : 0)
  })
}

exports.main = async event => {
  const { genre, year, month, artistId, id } = event
  const page = event.page || 1
  const pageSize = event.pageSize || 20
  const keyword = event.keyword || ''
  const sortBy = event.sortBy || 'avgScore'
  try {
    if (id) return { success: true, album: (await db.collection('albums').doc(id).get()).data }
    if (keyword) {
      const re = db.RegExp({ regexp: keyword, options: 'i' })
      const [res1, res2] = await Promise.all([
        db.collection('albums').where({ approved: true, title: re }).limit(50).get(),
        db.collection('albums').where({ approved: true, artist: re }).limit(50).get(),
      ])
      const seen = {}, seenKey = {}, merged = []
      res1.data.concat(res2.data).forEach(a => {
        if (seen[a._id]) return
        const dupKey = `${String(a.title || '').toLowerCase()}|||${String(a.artist || '').toLowerCase()}`
        if (seenKey[dupKey]) return
        seen[a._id] = true; seenKey[dupKey] = true; merged.push(a)
      })
      const filtered = merged.filter(a => !genre || (a.genres || []).includes(genre)).filter(a => {
        if (!year) return true
        const y = a.releaseYear
        return year === '2010s' ? y >= 2010 && y <= 2017 : year === '2000s' ? y >= 2000 && y <= 2009 : y === parseInt(year)
      }).filter(a => !month || !year || !/^\d{4}$/.test(String(year)) || String(a.releaseDate || '').slice(5, 7) === String(month).padStart(2, '0'))
      filtered.sort((a, b) => String(a.releaseDate || '9999-99-99').localeCompare(String(b.releaseDate || '9999-99-99')))
      return { success: true, list: filtered, total: filtered.length, page: 1, pageSize: filtered.length }
    }
    if (artistId) {
      const artistKey = String(artistId)
      // An album belongs to every artist in its album-level artists array.
      // Legacy main-artist lookup stays during historical-data backfill.
      const [coCreatorRes, legacyRes] = await Promise.all([
        db.collection('albums').where({ approved: true, collaboratorArtistIds: _.all([artistKey]) }).limit(1000).get(),
        db.collection('albums').where({ approved: true, neteaseArtistId: artistKey }).limit(1000).get(),
      ])
      const seen = {}, merged = []
      coCreatorRes.data.concat(legacyRes.data).forEach(a => { if (!seen[a._id]) { seen[a._id] = true; merged.push(a) } })
      const sorted = sortList(merged, sortBy), start = (page - 1) * pageSize
      return { success: true, list: sorted.slice(start, start + pageSize), total: sorted.length, page, pageSize }
    }
    const filters = { approved: true }
    if (genre) filters.genres = _.all([genre])
    else if (year) filters.releaseYear = year === '2010s' ? _.gte(2010).and(_.lte(2017)) : year === '2000s' ? _.gte(2000).and(_.lte(2009)) : _.eq(parseInt(year))
    if (month && year && /^\d{4}$/.test(String(year))) filters.releaseDate = db.RegExp({ regexp: `^${year}-${String(month).padStart(2, '0')}-`, options: '' })
    const query = db.collection('albums').where(filters)
    const total = (await query.count()).total
    const field = sortBy === 'releaseYear' ? 'releaseDate' : 'avgScore'
    const listResult = await query.orderBy(field, sortBy === 'releaseYear' ? 'asc' : 'desc').skip((page - 1) * pageSize).limit(pageSize).get()
    return { success: true, list: listResult.data, total, page, pageSize }
  } catch (err) { return { success: false, error: err.message } }
}
