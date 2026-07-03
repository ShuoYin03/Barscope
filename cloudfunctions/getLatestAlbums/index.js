const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function isoDay(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

function mondayISO() {
  const now = new Date()
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const offset = (local.getDay() + 6) % 7
  local.setDate(local.getDate() - offset)
  return local.toISOString().slice(0, 10)
}

exports.main = async (event) => {
  const limit = Math.min(Number(event.limit || 10), 30)
  const weekStart = mondayISO()
  try {
    const fields = { _id: true, title: true, artist: true, primaryArtist: true, releaseDate: true, releaseYear: true, coverUrl: true }
    const datedRes = await db.collection('albums')
      .where({ approved: _.neq(false), releaseDate: _.exists(true) })
      .field(fields)
      .orderBy('releaseDate', 'desc')
      .limit(100)
      .get()

    const dated = (datedRes.data || []).map(a => ({ ...a, _releaseDay: isoDay(a.releaseDate) }))
    const weekly = dated.filter(a => a._releaseDay && a._releaseDay >= weekStart).slice(0, limit)

    // Landing should always feel alive. If the current week has fewer than requested albums,
    // top it up with the latest dated releases rather than reverting to year-only ordering.
    const list = weekly.slice()
    const seen = new Set(list.map(a => a._id))
    dated.forEach(a => {
      if (list.length < limit && !seen.has(a._id)) { list.push(a); seen.add(a._id) }
    })

    const normalized = list.slice(0, limit).map(a => ({
      albumId: a._id,
      title: a.title || '',
      artist: a.primaryArtist || a.artist || '',
      displayArtist: a.primaryArtist || a.artist || '',
      releaseDate: isoDay(a.releaseDate),
      releaseYear: a.releaseYear || '',
      coverUrl: a.coverUrl || '',
      tickerText: `${a.primaryArtist || a.artist || ''} · ${a.title || ''}`,
      isThisWeek: !!a._releaseDay && a._releaseDay >= weekStart,
    }))

    return { success: true, weekStart, list: normalized, tickerSongs: normalized.map(a => a.tickerText).filter(Boolean) }
  } catch (e) {
    return { success: false, error: e.message, list: [], tickerSongs: [] }
  }
}