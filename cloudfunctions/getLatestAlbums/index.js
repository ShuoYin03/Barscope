const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function bjTodayISO() {
  const now = new Date()
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  return bj.toISOString().slice(0, 10)
}

function bjCurrentYear() {
  return Number(bjTodayISO().slice(0, 4))
}

function normalizeDay(value) {
  if (!value) return ''
  if (typeof value === 'string') {
    const m = value.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
    const compact = value.match(/^(\d{4})(\d{2})(\d{2})$/)
    if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
    return value.slice(0, 10).replace(/\./g, '-')
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

function releaseSortKey(album) {
  const day = normalizeDay(album.releaseDate)
  if (day) return day
  const year = Number(album.releaseYear || 0)
  return year ? `${year}-01-01` : '0000-00-00'
}

exports.main = async (event) => {
  const limit = Math.min(Math.max(Number(event.limit || 30), 1), 30)
  const today = bjTodayISO()
  const currentYear = bjCurrentYear()
  try {
    const fields = {
      _id: true,
      title: true,
      artist: true,
      primaryArtist: true,
      releaseDate: true,
      releaseYear: true,
      coverUrl: true,
      _createTime: true,
      reviewCount: true,
      avgScore: true,
      trackCount: true,
    }

    // Recent releases should be based on real release date, not crawler insertion time.
    // Cloud DB sorting is limited when releaseDate formats are mixed, so fetch a wider
    // current-year pool and sort in JS using Beijing today's date as the upper bound.
    const res = await db.collection('albums')
      .where({ approved: _.neq(false), releaseYear: _.gte(currentYear - 1) })
      .field(fields)
      .orderBy('releaseYear', 'desc')
      .limit(1000)
      .get()

    const source = (res.data || [])
      .map(a => ({ ...a, _releaseDay: normalizeDay(a.releaseDate), _sortDay: releaseSortKey(a) }))
      .filter(a => a._sortDay && a._sortDay <= today)

    source.sort((a, b) => {
      if (a._sortDay !== b._sortDay) return b._sortDay.localeCompare(a._sortDay)
      const ca = a._createTime ? new Date(a._createTime).getTime() : 0
      const cb = b._createTime ? new Date(b._createTime).getTime() : 0
      return cb - ca
    })

    const list = source.slice(0, limit)
    const normalized = list.map(a => ({
      albumId: a._id,
      title: a.title || '',
      artist: a.primaryArtist || a.artist || '',
      displayArtist: a.primaryArtist || a.artist || '',
      releaseDate: a._releaseDay || a._sortDay,
      releaseYear: a.releaseYear || Number((a._sortDay || '').slice(0, 4)) || currentYear,
      coverUrl: a.coverUrl || '',
      reviewCount: a.reviewCount || 0,
      avgScore: a.avgScore || 0,
      trackCount: a.trackCount || 0,
      tickerText: `${a.primaryArtist || a.artist || ''} · ${a.title || ''}`,
      isThisWeek: false,
    }))

    return { success: true, currentYear, today, list: normalized, tickerSongs: normalized.map(a => a.tickerText).filter(Boolean) }
  } catch (e) {
    return { success: false, error: e.message, list: [], tickerSongs: [] }
  }
}
