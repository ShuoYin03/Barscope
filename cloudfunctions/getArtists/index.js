const cloud = require('wx-server-sdk')
const BRAND_MAP = require('./artistBrandMap')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const PINYIN_STARTS = [['A','阿'],['B','芭'],['C','嚓'],['D','搭'],['E','蛾'],['F','发'],['G','噶'],['H','哈'],['J','击'],['K','喀'],['L','垃'],['M','妈'],['N','拿'],['O','哦'],['P','啪'],['Q','期'],['R','然'],['S','撒'],['T','塌'],['W','挖'],['X','昔'],['Y','压'],['Z','匝']]
const LETTER_ORDER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'
exports.main = async (event) => {
  const keyword = String(event.keyword || '').trim()
  const limit = Math.min(Number(event.limit || 1000), 1000)
  try {
    const conditions = { status: 'approved' }
    if (keyword) conditions.artistName = db.RegExp({ regexp: keyword, options: 'i' })
    const [res, countRes] = await Promise.all([
      db.collection('artist_candidates').where(conditions).field({_id:true,artistId:true,artistName:true,picUrl:true,avatarUrl:true,heroImageUrl:true,backgroundUrl:true,coverUrl:true,fansSize:true}).limit(limit).get(),
      db.collection('artist_candidates').where(conditions).count(),
    ])
    const candidates = res.data.filter(a => a.artistId && a.artistName)
    const profileMap = await fetchArtistProfiles(candidates.map(a => String(a.artistId)))
    const baseList = candidates.map(a => {
      const profile = profileMap.get(String(a.artistId)) || {}
      const artistName = profile.artistName || profile.name || a.artistName || ''
      const avatarUrl = firstNonEmpty([profile.avatarUrl,profile.picUrl,a.avatarUrl,a.picUrl,profile.heroImageUrl,profile.backgroundUrl,profile.coverUrl,a.heroImageUrl,a.backgroundUrl,a.coverUrl])
      const heroImageUrl = firstNonEmpty([profile.heroImageUrl,profile.backgroundUrl,profile.coverUrl,a.heroImageUrl,a.backgroundUrl,a.coverUrl,profile.picUrl,profile.avatarUrl,a.picUrl,a.avatarUrl])
      const artistId = String(a.artistId)
      return { id:a._id, artistId, artistName, picUrl:avatarUrl, avatarUrl, heroImageUrl, backgroundUrl:heroImageUrl, albumSize:0, fansSize:profile.fansSize||a.fansSize||0, letter:firstLetter(artistName), brand: BRAND_MAP[artistId] || '' }
    })
    const list = (await attachInAppAlbumCounts(baseList)).sort((a,b) => { const la=LETTER_ORDER.indexOf(a.letter)>=0?LETTER_ORDER.indexOf(a.letter):26,lb=LETTER_ORDER.indexOf(b.letter)>=0?LETTER_ORDER.indexOf(b.letter):26; if(la!==lb)return la-lb; return a.artistName.localeCompare(b.artistName,'zh-Hans-CN-u-co-pinyin',{sensitivity:'base',numeric:true}) })
    return { success:true, list, total:countRes.total }
  } catch (e) { return { success:false, error:e.message } }
}
async function fetchArtistProfiles(artistIds){const map=new Map();for(let i=0;i<artistIds.length;i+=100){const r=await db.collection('artists').where({neteaseArtistId:_.in(artistIds.slice(i,i+100))}).field({neteaseArtistId:true,artistId:true,name:true,artistName:true,picUrl:true,avatarUrl:true,heroImageUrl:true,backgroundUrl:true,coverUrl:true,fansSize:true}).limit(1000).get().catch(()=>({data:[]}));(r.data||[]).forEach(item=>{const key=String(item.neteaseArtistId||item.artistId||'');if(key)map.set(key,item)})}return map}
async function attachInAppAlbumCounts(artists){if(!artists.length)return[];const ids=artists.map(a=>String(a.artistId)),names=artists.map(a=>a.artistName),byId=new Map(),idByName=new Map();artists.forEach(a=>{byId.set(String(a.artistId),new Set());idByName.set(a.artistName,String(a.artistId))});const add=(id,albumId)=>{if(!id||!albumId)return;if(!byId.has(String(id)))byId.set(String(id),new Set());byId.get(String(id)).add(albumId)};for(let i=0;i<ids.length;i+=100){const r=await db.collection('albums').where({neteaseArtistId:_.in(ids.slice(i,i+100)),approved:_.neq(false)}).field({_id:true,neteaseArtistId:true}).limit(1000).get();(r.data||[]).forEach(x=>add(x.neteaseArtistId,x._id))}for(let i=0;i<names.length;i+=100){const r=await db.collection('albums').where({primaryArtist:_.in(names.slice(i,i+100)),approved:_.neq(false)}).field({_id:true,primaryArtist:true}).limit(1000).get();(r.data||[]).forEach(x=>add(idByName.get(x.primaryArtist),x._id))}return artists.map(a=>({...a,albumSize:(byId.get(String(a.artistId))||new Set()).size}))}
function firstLetter(name){for(const ch of Array.from(String(name||'').trim())){if(/[A-Za-z]/.test(ch))return ch.toUpperCase();if(/[\u4e00-\u9fff]/.test(ch))return pinyinInitial(ch)}return'#'}
function pinyinInitial(ch){let letter='#';for(const [initial,startChar] of PINYIN_STARTS){if(ch.localeCompare(startChar,'zh-Hans-CN-u-co-pinyin')>=0)letter=initial;else break}return letter}
function firstNonEmpty(values){return values.find(v=>String(v||'').trim())||''}
