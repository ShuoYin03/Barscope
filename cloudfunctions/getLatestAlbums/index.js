const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function isoDay(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

function mondayISO() {
  const now = new Date()
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  local.setDate(local.getDate() - ((local.getDay() + 6) % 7))
  return local.toISOString().slice(0, 10)
}

exports.main = async (event) => {
  const limit = Math.min(Number(event.limit || 10), 30)
  const currentYear = new Date().getFullYear()
  const weekStart = mondayISO()
  try {
    const fields = { _id: true, title: true, artist: true, primaryArtist: true, releaseDate: true, releaseYear: true, coverUrl: true, _createTime: true }

    // Home landing is intentionally strict: only current-year releases can appear here.
    // Sort first by the actual day of release; records without a day-level date fall back
    // to their newest crawler insertion time, never to older release years.
    const res = await db.collection('albums')
      .where({ approved: _.neq(false), releaseYear: currentYear })
      .field(fields)
      .orderBy('_createTime', 'desc')
      .limit(100)
      .get()

    const source = (res.data || []).map(a => ({ ...a, _releaseDay: isoDay(a.releaseDate) }))
    source.sort((a, b) => {
      const da = a._releaseDay || ''
      const dbb = b._releaseDay || ''
      if (da !== dbb) return dbb.localeCompare(da)
      return 0
    })

    // This week's releases sit first; the remainder is the latest 2026 release pool.
    const weekly = source.filter(a => a._releaseDay && a._releaseDay >= weekStart)
    const remainder = source.filter(a => !(a._releaseDay && a._releaseDay >= weekStart))
    const list = weekly.concat(remainder).slice(0, limit)

    const normalized = list.map(a => ({
      albumId: a._id,
      title: a.title || '',
      artist: a.primaryArtist || a.artist || '',
      displayArtist: a.primaryArtist || a.artist || '',
      releaseDate: a._releaseDay,
      releaseYear: a.releaseYear || currentYear,
      coverUrl: a.coverUrl || '',
      tickerText: `${a.primaryArtist || a.artist || ''} · ${a.title || ''}`,
      isThisWeek: !!a._releaseDay && a._releaseDay >= weekStart,
    }))

    return { success: true, currentYear, weekStart, list: normalized, tickerSongs: normalized.map(a => a.tickerText).filter(Boolean) }
  } catch (e) {
    return { success: false, error: e.message, list: [], tickerSongs: [] }
  }
}