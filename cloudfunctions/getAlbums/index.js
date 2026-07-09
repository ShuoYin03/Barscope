const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function releaseDay(a) {
  const d = String(a.releaseDate || '')
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10)
  const y = Number(a.releaseYear || 0)
  return y ? `${y}-01-01` : '0000-00-00'
}

function sortList(list, sortBy) {
  if (sortBy === 'allMixed') return sortAllMixed(list)
  const field = sortBy === 'releaseYear' ? 'releaseDate' : 'avgScore'
  const direction = sortBy === 'releaseYear' ? -1 : -1
  return list.slice().sort((a, b) => {
    const av = field === 'releaseDate' ? releaseDay(a) : Number(a[field] || 0)
    const bv = field === 'releaseDate' ? releaseDay(b) : Number(b[field] || 0)
    return direction * (av > bv ? 1 : av < bv ? -1 : 0)
  })
}

function sortAllMixed(list) {
  return list.slice().sort((a, b) => {
    const as = Number(a.avgScore || 0)
    const bs = Number(b.avgScore || 0)
    const aRated = as > 0
    const bRated = bs > 0
    if (aRated && bRated) {
      if (bs !== as) return bs - as
      return releaseDay(b).localeCompare(releaseDay(a))
    }
    if (aRated !== bRated) return aRated ? -1 : 1
    return releaseDay(b).localeCompare(releaseDay(a))
  })
}

function dedupe(list) {
  const seen = {}, seenKey = {}, out = []
  list.forEach(a => {
    if (seen[a._id]) return
    const dupKey = `${String(a.title || '').toLowerCase()}|||${String(a.artist || '').toLowerCase()}`
    if (seenKey[dupKey]) return
    seen[a._id] = true
    seenKey[dupKey] = true
    out.push(a)
  })
  return out
}

exports.main = async event => {
  const { genre, year, month, artistId, id } = event
  const page = Number(event.page || 1)
  const pageSize = Math.min(Number(event.pageSize || 20), 100)
  const keyword = String(event.keyword || '').trim()
  const sortBy = event.sortBy || 'avgScore'
  try {
    if (id) return { success: true, album: (await db.collection('albums').doc(id).get()).data }

    if (keyword) {
      const re = db.RegExp({ regexp: keyword, options: 'i' })
      const [res1, res2] = await Promise.all([
        db.collection('albums').where({ approved: true, title: re }).limit(500).get(),
        db.collection('albums').where({ approved: true, artist: re }).limit(500).get(),
      ])
      const merged = dedupe(res1.data.concat(res2.data))
      const filtered = merged.filter(a => !genre || (a.genres || []).includes(genre)).filter(a => {
        if (!year || year === '全部') return true
        const y = a.releaseYear
        return year === '2010s' ? y >= 2010 && y <= 2017 : year === '2000s' ? y >= 2000 && y <= 2009 : y === parseInt(year)
      }).filter(a => !month || !year || !/^\d{4}$/.test(String(year)) || String(a.releaseDate || '').slice(5, 7) === String(month).padStart(2, '0'))
      const sorted = sortList(filtered, sortBy)
      const start = (page - 1) * pageSize
      return { success: true, list: sorted.slice(start, start + pageSize), total: sorted.length, page, pageSize }
    }

    if (artistId) {
      const artistKey = String(artistId)
      const [coCreatorRes, legacyRes] = await Promise.all([
        db.collection('albums').where({ approved: true, artistIds: _.all([artistKey]) }).limit(1000).get(),
        db.collection('albums').where({ approved: true, neteaseArtistId: artistKey }).limit(1000).get(),
      ])
      const sorted = sortList(dedupe(coCreatorRes.data.concat(legacyRes.data)), sortBy)
      const start = (page - 1) * pageSize
      return { success: true, list: sorted.slice(start, start + pageSize), total: sorted.length, page, pageSize }
    }

    const filters = { approved: true }
    if (genre) filters.genres = _.all([genre])
    else if (year && year !== '全部') filters.releaseYear = year === '2010s' ? _.gte(2010).and(_.lte(2017)) : year === '2000s' ? _.gte(2000).and(_.lte(2009)) : _.eq(parseInt(year))
    if (month && year && /^\d{4}$/.test(String(year))) filters.releaseDate = db.RegExp({ regexp: `^${year}-${String(month).padStart(2, '0')}-`, options: '' })
    const query = db.collection('albums').where(filters)
    const total = (await query.count()).total

    if (sortBy === 'allMixed' || !year || year === '全部') {
      const all = []
      const MAX = 5000
      for (let offset = 0; offset < Math.min(total, MAX); offset += 1000) {
        const r = await query.skip(offset).limit(1000).get()
        all.push(...(r.data || []))
      }
      const sorted = sortList(all, 'allMixed')
      const start = (page - 1) * pageSize
      return { success: true, list: sorted.slice(start, start + pageSize), total: sorted.length, page, pageSize }
    }

    const field = sortBy === 'releaseYear' ? 'releaseDate' : 'avgScore'
    const listResult = await query.orderBy(field, sortBy === 'releaseYear' ? 'desc' : 'desc').skip((page - 1) * pageSize).limit(pageSize).get()
    return { success: true, list: listResult.data, total, page, pageSize }
  } catch (err) { return { success: false, error: err.message } }
}
