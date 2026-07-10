const cloud = require('wx-server-sdk')
const { pinyin } = require('pinyin-pro')
const BRAND_MAP = require('./artistBrandMap')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const PINYIN_STARTS = [['A','阿'],['B','芭'],['C','嚓'],['D','搭'],['E','蛾'],['F','发'],['G','噶'],['H','哈'],['J','击'],['K','喀'],['L','垃'],['M','妈'],['N','拿'],['O','哦'],['P','啪'],['Q','期'],['R','然'],['S','撒'],['T','塌'],['W','挖'],['X','昔'],['Y','压'],['Z','匝']]
const LETTER_ORDER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'
const HIGHER_BROTHERS_IDS = new Set(['1132392', '27868624', '29303235', '29304235'])

function normalize(v){ return String(v || '').trim().toLowerCase().replace(/[\s._\-·'’]/g, '') }
function searchForms(name){
  const raw = String(name || '')
  const full = pinyin(raw, { toneType:'none', type:'array' })
  return [normalize(raw), normalize(full.join('')), normalize(full.join(' ')), normalize(full.map(x => x.charAt(0)).join(''))]
}
function matchesKeyword(name, keyword){
  const q = normalize(keyword)
  if (!q) return true
  return searchForms(name).some(x => x.includes(q))
}
function cleanBrands(values){
  const seen = new Set()
  return (Array.isArray(values) ? values : []).map(x => String(x || '').trim()).filter(x => x && !seen.has(x) && seen.add(x))
}

exports.main = async event => {
  const keyword = String(event.keyword || '').trim()
  const limit = Math.min(Number(event.limit || 1000), 1000)
  try {
    const conditions = { status: 'approved' }
    const [res, albumCountMap] = await Promise.all([
      db.collection('artist_candidates').where(conditions).field({ _id:true, artistId:true, artistName:true, picUrl:true, avatarUrl:true, coverUrl:true, fansSize:true, brand:true, brands:true }).limit(1000).get(),
      fetchApprovedAlbumCounts(),
    ])
    const all = (res.data || []).filter(a => a.artistId && a.artistName)
    const filtered = keyword ? all.filter(a => matchesKeyword(a.artistName, keyword)) : all
    const list = filtered.slice(0, limit).map(a => {
      const artistId = String(a.artistId)
      const artistName = a.artistName || ''
      const managedBrands = cleanBrands(a.brands && a.brands.length ? a.brands : (a.brand ? [a.brand] : []))
      const legacyBrand = BRAND_MAP[artistId] || ''
      const brands = managedBrands.length ? managedBrands : (legacyBrand ? [legacyBrand] : [])
      if (HIGHER_BROTHERS_IDS.has(artistId) && !brands.includes('成都集团')) brands.push('成都集团')
      return { id:a._id, artistId, artistName, picUrl:a.avatarUrl || a.picUrl || a.coverUrl || '', albumSize:albumCountMap.get(artistId) || 0, fansSize:Number(a.fansSize || 0), letter:firstLetter(artistName), brand:brands[0] || '', brands }
    }).sort((a,b) => {
      const la = LETTER_ORDER.indexOf(a.letter) >= 0 ? LETTER_ORDER.indexOf(a.letter) : 26
      const lb = LETTER_ORDER.indexOf(b.letter) >= 0 ? LETTER_ORDER.indexOf(b.letter) : 26
      return la !== lb ? la - lb : a.artistName.localeCompare(b.artistName, 'zh-Hans-CN-u-co-pinyin', { sensitivity:'base', numeric:true })
    })
    return { success:true, list, total:filtered.length }
  } catch (e) { return { success:false, error:e.message } }
}

async function fetchApprovedAlbumCounts() {
  const countResult = await db.collection('albums').where({ approved:true }).count()
  const total = Number(countResult.total || 0)
  const pageSize = 100
  const pages = Math.ceil(total / pageSize)
  const batches = []
  for (let page = 0; page < pages; page++) {
    batches.push(db.collection('albums').where({ approved:true }).field({ _id:true, neteaseArtistId:true, artistIds:true }).skip(page * pageSize).limit(pageSize).get())
  }
  const rows = (await Promise.all(batches)).flatMap(x => x.data || [])
  const map = new Map()
  rows.forEach(album => {
    const ids = new Set()
    if (album.neteaseArtistId) ids.add(String(album.neteaseArtistId))
    if (Array.isArray(album.artistIds)) album.artistIds.forEach(id => { if (id) ids.add(String(id)) })
    ids.forEach(id => map.set(id, (map.get(id) || 0) + 1))
  })
  return map
}
function firstLetter(name){for(const ch of Array.from(String(name||'').trim())){if(/[A-Za-z]/.test(ch))return ch.toUpperCase();if(/[\u4e00-\u9fff]/.test(ch))return pinyinInitial(ch)}return '#'}
function pinyinInitial(ch){let letter='#';for(const [initial,startChar] of PINYIN_STARTS){if(ch.localeCompare(startChar,'zh-Hans-CN-u-co-pinyin')>=0)letter=initial;else break}return letter}
