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
  const weekStart = mondayISO()
  try {
    const fields = { _id: true, title: true, artist: true, primaryArtist: true, releaseDate: true, releaseYear: true, coverUrl: true, _createTime: true }
    const datedRes = await db.collection('albums').where({ approved: _.neq(false), releaseDate: _.exists(true) }).field(fields).orderBy('releaseDate', 'desc').limit(100).get()
    const dated = (datedRes.data || []).map(a => ({ ...a, _releaseDay: isoDay(a.releaseDate) }))
    const list = dated.filter(a => a._releaseDay && a._releaseDay >= weekStart).slice(0, limit)
    const seen = new Set(list.map(a => a._id))
    dated.forEach(a => { if (list.length < limit && !seen.has(a._id)) { list.push(a); seen.add(a._id) } })

    // Older records do not have a day-level releaseDate. For them, use database insertion time:
    // the daily crawler writes genuinely new discoveries first, so this is a better landing fallback than releaseYear.
    if (list.length < limit) {
      const recentRes = await db.collection('albums').where({ approved: _.neq(false) }).field(fields).orderBy('_createTime', 'desc').limit(limit * 3).get()
      ;(recentRes.data || []).forEach(a => {
        if (list.length < limit && !seen.has(a._id)) { list.push({ ...a, _releaseDay: isoDay(a.releaseDate) }); seen.add(a._id) }
      })
    }

    const normalized = list.slice(0, limit).map(a => ({
      albumId: a._id, title: a.title || '', artist: a.primaryArtist || a.artist || '', displayArtist: a.primaryArtist || a.artist || '',
      releaseDate: isoDay(a.releaseDate), releaseYear: a.releaseYear || '', coverUrl: a.coverUrl || '',
      tickerText: `${a.primaryArtist || a.artist || ''} · ${a.title || ''}`,
      isThisWeek: !!a._releaseDay && a._releaseDay >= weekStart,
    }))
    return { success: true, weekStart, list: normalized, tickerSongs: normalized.map(a => a.tickerText).filter(Boolean) }
  } catch (e) { return { success: false, error: e.message, list: [], tickerSongs: [] } }
}