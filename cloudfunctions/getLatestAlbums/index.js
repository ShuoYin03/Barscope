const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const limit = Math.min(Number(event.limit || 10), 30)

  try {
    // Prefer records with full releaseDate when available.
    const fullDateRes = await db.collection('albums')
      .where({
        approved: _.neq(false),
        releaseDate: _.exists(true),
      })
      .field({
        _id: true,
        title: true,
        artist: true,
        primaryArtist: true,
        releaseDate: true,
        releaseYear: true,
        coverUrl: true,
      })
      .orderBy('releaseDate', 'desc')
      .limit(limit)
      .get()

    let list = fullDateRes.data || []

    // Legacy fallback: older crawled albums may only have releaseYear.
    if (list.length < limit) {
      const yearRes = await db.collection('albums')
        .where({ approved: _.neq(false) })
        .field({
          _id: true,
          title: true,
          artist: true,
          primaryArtist: true,
          releaseDate: true,
          releaseYear: true,
          coverUrl: true,
        })
        .orderBy('releaseYear', 'desc')
        .limit(limit * 2)
        .get()

      const seen = new Set(list.map(a => a._id))
      ;(yearRes.data || []).forEach(a => {
        if (!seen.has(a._id) && list.length < limit) {
          seen.add(a._id)
          list.push(a)
        }
      })
    }

    const normalized = list.slice(0, limit).map(a => ({
      albumId: a._id,
      title: a.title || '',
      artist: a.primaryArtist || a.artist || '',
      displayArtist: a.primaryArtist || a.artist || '',
      releaseDate: a.releaseDate || '',
      releaseYear: a.releaseYear || '',
      coverUrl: a.coverUrl || '',
      tickerText: `${a.primaryArtist || a.artist || ''} · ${a.title || ''}`,
    }))

    return {
      success: true,
      list: normalized,
      tickerSongs: normalized.map(a => a.tickerText).filter(Boolean),
    }
  } catch (e) {
    return { success: false, error: e.message, list: [], tickerSongs: [] }
  }
}
