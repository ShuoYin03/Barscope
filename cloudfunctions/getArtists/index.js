const cloud = require('wx-server-sdk')
const BRAND_MAP = require('./artistBrandMap')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const PINYIN_STARTS = [['A','阿'],['B','芭'],['C','嚓'],['D','搭'],['E','蛾'],['F','发'],['G','噶'],['H','哈'],['J','击'],['K','喀'],['L','垃'],['M','妈'],['N','拿'],['O','哦'],['P','啪'],['Q','期'],['R','然'],['S','撒'],['T','塌'],['W','挖'],['X','昔'],['Y','压'],['Z','匝']]
const LETTER_ORDER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'
const HIGHER_BROTHERS_IDS = new Set(['1132392', '27868624', '29303235', '29304235'])

exports.main = async (event) => {
  const keyword = String(event.keyword || '').trim()
  const limit = Math.min(Number(event.limit || 1000), 1000)
  try {
    const conditions = { status: 'approved' }
    if (keyword) conditions.artistName = db.RegExp({ regexp: keyword, options: 'i' })
    const [res, countRes] = await Promise.all([
      db.collection('artist_candidates').where(conditions).field({ _id:true, artistId:true, artistName:true, picUrl:true, avatarUrl:true, coverUrl:true, fansSize:true, albumSize:true }).limit(limit).get(),
      db.collection('artist_candidates').where(conditions).count(),
    ])
    const list = res.data.filter(a => a.artistId && a.artistName).map(a => {
      const artistId = String(a.artistId)
      const artistName = a.artistName || ''
      const primaryBrand = BRAND_MAP[artistId] || ''
      const brands = primaryBrand ? [primaryBrand] : []
      if (HIGHER_BROTHERS_IDS.has(artistId) && brands.indexOf('成都集团') < 0) brands.push('成都集团')
      return { id:a._id, artistId, artistName, picUrl:a.avatarUrl || a.picUrl || a.coverUrl || '', albumSize:Number(a.albumSize || 0), fansSize:Number(a.fansSize || 0), letter:firstLetter(artistName), brand:primaryBrand, brands }
    }).sort((a,b) => {
      const la=LETTER_ORDER.indexOf(a.letter)>=0?LETTER_ORDER.indexOf(a.letter):26
      const lb=LETTER_ORDER.indexOf(b.letter)>=0?LETTER_ORDER.indexOf(b.letter):26
      if(la!==lb)return la-lb
      return a.artistName.localeCompare(b.artistName,'zh-Hans-CN-u-co-pinyin',{sensitivity:'base',numeric:true})
    })
    return { success:true, list, total:countRes.total }
  } catch (e) { return { success:false, error:e.message } }
}
function firstLetter(name){for(const ch of Array.from(String(name||'').trim())){if(/[A-Za-z]/.test(ch))return ch.toUpperCase();if(/[\u4e00-\u9fff]/.test(ch))return pinyinInitial(ch)}return '#'}
function pinyinInitial(ch){let letter='#';for(const [initial,startChar] of PINYIN_STARTS){if(ch.localeCompare(startChar,'zh-Hans-CN-u-co-pinyin')>=0)letter=initial;else break}return letter}
