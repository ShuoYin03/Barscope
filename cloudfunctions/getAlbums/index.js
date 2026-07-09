const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function isAllYear(year) {
  return year === 'ALL'
}
function releaseDay(a) {
  const d = String(a.releaseDate || '')
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10)
  const y = Number(a.releaseYear || 0)
  return y ? `${y}-01-01` : '0000-00-00'
}
function hasRating(a) {
  return Number(a.reviewCount || 0) > 0 && Number(a.avgScore || 0) > 0
}
function sortAll(list) {
  return list.slice().sort((a, b) => {
    const ar = hasRating(a)
    const br = hasRating(b)
    if (ar && br) {
      const diff = Number(b.avgScore || 0) - Number(a.avgScore || 0)
      if (diff) return diff
      return releaseDay(b).localeCompare(releaseDay(a))
    }
    if (ar !== br) return ar ? -1 : 1
    return releaseDay(b).localeCompare(releaseDay(a))
  })
}
function sortList(list, sortBy) {
  if (sortBy === 'allRatedFirst') return sortAll(list)
  const field = sortBy === 'releaseYear' ? 'releaseDate' : 'avgScore'
  const direction = sortBy === 'releaseYear' ? 1 : -1
  return list.slice().sort((a, b) => {
    const av = a[field] || (direction === 1 ? '9999-99-99' : 0)
    const bv = b[field] || (direction === 1 ? '9999-99-99' : 0)
    return direction * (av > bv ? 1 : av < bv ? -1 : 0)
  })
}
function dedupe(list) {
  const seen = {}, seenKey = {}, merged = []
  list.forEach(a => {
    if (seen[a._id]) return
    const dupKey = `${String(a.title || '').toLowerCase()}|||${String(a.artist || '').toLowerCase()}`
    if (seenKey[dupKey]) return
    seen[a._id] = true; seenKey[dupKey] = true; merged.push(a)
  })
  return merged
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
        db.collection('albums').where({ approved: true, title: re }).limit(500).get(),
        db.collection('albums').where({ approved: true, artist: re }).limit(500).get(),
      ])
      const filtered = dedupe(res1.data.concat(res2.data)).filter(a => !genre || (a.genres || []).includes(genre)).filter(a => {
        if (!year || isAllYear(year)) return true
        const y = a.releaseYear
        return year === '2010s' ? y >= 2010 && y <= 2017 : year === '2000s' ? y >= 2000 && y <= 2009 : y === parseInt(year)
      }).filter(a => !month || !year || !/^\d{4}$/.test(String(year)) || String(a.releaseDate || '').slice(5, 7) === String(month).padStart(2, '0'))
      const sorted = isAllYear(year) || sortBy === 'allRatedFirst' ? sortAll(filtered) : filtered.sort((a, b) => String(a.releaseDate || '9999-99-99').localeCompare(String(b.releaseDate || '9999-99-99')))
      return { success: true, list: sorted, total: sorted.length, page: 1, pageSize: sorted.length }
    }
    if (artistId) {
      const artistKey = String(artistId)
      const [coCreatorRes, legacyRes] = await Promise.all([
        db.collection('albums').where({ approved: true, artistIds: _.all([artistKey]) }).limit(1000).get(),
        db.collection('albums').where({ approved: true, neteaseArtistId: artistKey }).limit(1000).get(),
      ])
      const sorted = sortList(dedupe(coCreatorRes.data.concat(legacyRes.data)), sortBy), start = (page - 1) * pageSize
      return { success: true, list: sorted.slice(start, start + pageSize), total: sorted.length, page, pageSize }
    }
    const filters = { approved: true }
    if (genre) filters.genres = _.all([genre])
    else if (year && !isAllYear(year)) filters.releaseYear = year === '2010s' ? _.gte(2010).and(_.lte(2017)) : year === '2000s' ? _.gte(2000).and(_.lte(2009)) : _.eq(parseInt(year))
    if (month && year && /^\d{4}$/.test(String(year))) filters.releaseDate = db.RegExp({ regexp: `^${year}-${String(month).padStart(2, '0')}-`, options: '' })
    const query = db.collection('albums').where(filters)
    const total = (await query.count()).total

    if (isAllYear(year) || sortBy === 'allRatedFirst') {
      const all = []
      const max = Math.min(total, 5000)
      for (let offset = 0; offset < max; offset += 1000) {
        const r = await query.skip(offset).limit(1000).get()
        all.push(...(r.data || []))
      }
      const sorted = sortAll(all)
      const start = (page - 1) * pageSize
      return { success: true, list: sorted.slice(start, start + pageSize), total: sorted.length, page, pageSize }
    }

    const field = sortBy === 'releaseYear' ? 'releaseDate' : 'avgScore'
    const listResult = await query.orderBy(field, sortBy === 'releaseYear' ? 'asc' : 'desc').skip((page - 1) * pageSize).limit(pageSize).get()
    return { success: true, list: listResult.data, total, page, pageSize }
  } catch (err) { return { success: false, error: err.message } }
}
