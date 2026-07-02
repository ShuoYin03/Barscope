const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const PINYIN_STARTS = [
  ['A', '阿'], ['B', '芭'], ['C', '嚓'], ['D', '搭'], ['E', '蛾'], ['F', '发'],
  ['G', '噶'], ['H', '哈'], ['J', '击'], ['K', '喀'], ['L', '垃'], ['M', '妈'],
  ['N', '拿'], ['O', '哦'], ['P', '啪'], ['Q', '期'], ['R', '然'], ['S', '撒'],
  ['T', '塌'], ['W', '挖'], ['X', '昔'], ['Y', '压'], ['Z', '匝'],
]

const LETTER_ORDER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'

exports.main = async (event) => {
  const keyword = String(event.keyword || '').trim()
  const limit = Math.min(Number(event.limit || 500), 500)

  try {
    const conditions = { status: 'approved' }
    if (keyword) {
      conditions.artistName = db.RegExp({ regexp: keyword, options: 'i' })
    }

    const res = await db.collection('artist_candidates')
      .where(conditions)
      .field({
        _id: true,
        artistId: true,
        artistName: true,
        picUrl: true,
        avatarUrl: true,
        heroImageUrl: true,
        backgroundUrl: true,
        coverUrl: true,
        fansSize: true,
      })
      .limit(limit)
      .get()

    const candidates = res.data.filter(a => a.artistId && a.artistName)
    const artistIds = candidates.map(a => String(a.artistId))
    const profileMap = await fetchArtistProfiles(artistIds)

    const baseList = candidates.map(a => {
      const profile = profileMap.get(String(a.artistId)) || {}
      const avatarUrl = firstNonEmpty([
        profile.avatarUrl,
        profile.picUrl,
        a.avatarUrl,
        a.picUrl,
        profile.heroImageUrl,
        profile.backgroundUrl,
        profile.coverUrl,
        a.heroImageUrl,
        a.backgroundUrl,
        a.coverUrl,
      ])
      const heroImageUrl = firstNonEmpty([
        profile.heroImageUrl,
        profile.backgroundUrl,
        profile.coverUrl,
        a.heroImageUrl,
        a.backgroundUrl,
        a.coverUrl,
        profile.picUrl,
        profile.avatarUrl,
        a.picUrl,
        a.avatarUrl,
      ])
      const artistName = profile.artistName || profile.name || a.artistName || ''
      return {
        id: a._id,
        artistId: String(a.artistId),
        artistName,
        picUrl: avatarUrl,
        avatarUrl,
        heroImageUrl,
        backgroundUrl: heroImageUrl,
        albumSize: 0,
        fansSize: profile.fansSize || a.fansSize || 0,
        letter: firstLetter(artistName),
      }
    })

    const listWithCounts = await attachInAppAlbumCounts(baseList)

    const list = listWithCounts.sort((a, b) => {
      const la = LETTER_ORDER.indexOf(a.letter) >= 0 ? LETTER_ORDER.indexOf(a.letter) : 26
      const lb = LETTER_ORDER.indexOf(b.letter) >= 0 ? LETTER_ORDER.indexOf(b.letter) : 26
      if (la !== lb) return la - lb
      return a.artistName.localeCompare(b.artistName, 'zh-Hans-CN-u-co-pinyin', { sensitivity: 'base', numeric: true })
    })

    return { success: true, list, total: list.length }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

async function fetchArtistProfiles(artistIds) {
  const map = new Map()
  for (let i = 0; i < artistIds.length; i += 100) {
    const chunk = artistIds.slice(i, i + 100)
    const r = await db.collection('artists')
      .where({ neteaseArtistId: _.in(chunk) })
      .field({
        neteaseArtistId: true,
        artistId: true,
        name: true,
        artistName: true,
        picUrl: true,
        avatarUrl: true,
        heroImageUrl: true,
        backgroundUrl: true,
        coverUrl: true,
        fansSize: true,
      })
      .limit(1000)
      .get()
      .catch(() => ({ data: [] }))

    ;(r.data || []).forEach(item => {
      const key = String(item.neteaseArtistId || item.artistId || '')
      if (key) map.set(key, item)
    })
  }
  return map
}

async function attachInAppAlbumCounts(artists) {
  if (!artists.length) return []

  const artistIds = artists.map(a => String(a.artistId)).filter(Boolean)
  const names = artists.map(a => a.artistName).filter(Boolean)
  const albumsByArtistId = new Map()
  const artistIdByName = new Map()

  artists.forEach(artist => {
    albumsByArtistId.set(String(artist.artistId), new Set())
    artistIdByName.set(artist.artistName, String(artist.artistId))
  })

  function addAlbumToArtist(artistId, albumId) {
    const key = String(artistId || '')
    if (!key || !albumId) return
    if (!albumsByArtistId.has(key)) albumsByArtistId.set(key, new Set())
    albumsByArtistId.get(key).add(albumId)
  }

  for (let i = 0; i < artistIds.length; i += 100) {
    const chunk = artistIds.slice(i, i + 100)
    const r = await db.collection('albums')
      .where({ neteaseArtistId: _.in(chunk), approved: _.neq(false) })
      .field({ _id: true, neteaseArtistId: true })
      .limit(1000)
      .get()
    ;(r.data || []).forEach(album => addAlbumToArtist(album.neteaseArtistId, album._id))
  }

  for (let i = 0; i < names.length; i += 100) {
    const chunk = names.slice(i, i + 100)
    const r = await db.collection('albums')
      .where({ primaryArtist: _.in(chunk), approved: _.neq(false) })
      .field({ _id: true, primaryArtist: true })
      .limit(1000)
      .get()
    ;(r.data || []).forEach(album => {
      const artistId = artistIdByName.get(album.primaryArtist)
      addAlbumToArtist(artistId, album._id)
    })
  }

  return artists.map(artist => ({
    ...artist,
    albumSize: (albumsByArtistId.get(String(artist.artistId)) || new Set()).size,
  }))
}

function firstLetter(name) {
  const chars = Array.from(String(name || '').trim())
  for (const ch of chars) {
    if (/[A-Za-z]/.test(ch)) return ch.toUpperCase()
    if (isChinese(ch)) return pinyinInitial(ch)
  }
  return '#'
}

function isChinese(ch) {
  return /[\u4e00-\u9fff]/.test(ch)
}

function pinyinInitial(ch) {
  let letter = '#'
  for (const item of PINYIN_STARTS) {
    const [initial, startChar] = item
    if (ch.localeCompare(startChar, 'zh-Hans-CN-u-co-pinyin') >= 0) {
      letter = initial
    } else {
      break
    }
  }
  return letter
}

function firstNonEmpty(values) {
  return values.find(v => String(v || '').trim()) || ''
}
