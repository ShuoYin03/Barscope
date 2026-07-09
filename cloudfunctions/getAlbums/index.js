const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function isAllYear(year) { return year === 'ALL' }
function releaseDay(a) { const d=String(a.releaseDate||''); if(/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0,10); const y=Number(a.releaseYear||0); return y?`${y}-01-01`:'0000-00-00' }
function sortList(list, sortBy) { const field=sortBy==='releaseYear'?'releaseDate':'avgScore'; const direction=sortBy==='releaseYear'?1:-1; return list.slice().sort((a,b)=>{const av=a[field]||(direction===1?'9999-99-99':0); const bv=b[field]||(direction===1?'9999-99-99':0); return direction*(av>bv?1:av<bv?-1:0)}) }
function dedupe(list){const seen={},seenKey={},merged=[];list.forEach(a=>{if(!a||seen[a._id])return;const dupKey=`${String(a.title||'').toLowerCase()}|||${String(a.artist||'').toLowerCase()}`;if(seenKey[dupKey])return;seen[a._id]=true;seenKey[dupKey]=true;merged.push(a)});return merged}
function baseFilters(genre){const filters={approved:true}; if(genre) filters.genres=_.all([genre]); return filters}
function ratedFilters(genre){return Object.assign(baseFilters(genre), { avgScore: _.gt(0), reviewCount: _.gt(0) })}
function unratedFilters(genre){return Object.assign(baseFilters(genre), { avgScore: _.lte(0) })}

async function fetchAllPage({ genre, page, pageSize }) {
  const ratedQuery = db.collection('albums').where(ratedFilters(genre))
  const unratedQuery = db.collection('albums').where(unratedFilters(genre))
  const [ratedCountRes, unratedCountRes] = await Promise.all([ratedQuery.count(), unratedQuery.count()])
  const ratedTotal = Number(ratedCountRes.total || 0)
  const unratedTotal = Number(unratedCountRes.total || 0)
  const total = ratedTotal + unratedTotal
  const start = (page - 1) * pageSize
  let list = []

  if (start < ratedTotal) {
    const ratedNeed = Math.min(pageSize, ratedTotal - start)
    const ratedRes = await ratedQuery.orderBy('avgScore', 'desc').orderBy('releaseDate', 'desc').skip(start).limit(ratedNeed).get()
    list = list.concat(ratedRes.data || [])
    if (list.length < pageSize) {
      const remain = pageSize - list.length
      const unratedRes = await unratedQuery.orderBy('title', 'asc').orderBy('releaseDate', 'desc').skip(0).limit(remain).get()
      list = list.concat(unratedRes.data || [])
    }
  } else {
    const unratedStart = start - ratedTotal
    const unratedRes = await unratedQuery.orderBy('title', 'asc').orderBy('releaseDate', 'desc').skip(unratedStart).limit(pageSize).get()
    list = unratedRes.data || []
  }

  return { success:true, list, total, page, pageSize, debug:{ year:'ALL', ratedTotal, unratedTotal, returned:list.length, start } }
}

exports.main = async event => {
  const { genre, year, month, artistId, id } = event
  const page = Number(event.page || 1)
  const pageSize = Math.min(Number(event.pageSize || 20), 100)
  const keyword = String(event.keyword || '').trim()
  const sortBy = event.sortBy || 'avgScore'
  try {
    if (id) return { success: true, album: (await db.collection('albums').doc(id).get()).data }

    if (isAllYear(year) || sortBy === 'allRatedFirst') {
      return await fetchAllPage({ genre, page, pageSize })
    }

    if (keyword) {
      const re = db.RegExp({ regexp: keyword, options: 'i' })
      const [res1, res2] = await Promise.all([
        db.collection('albums').where({ approved: true, title: re }).limit(100).get(),
        db.collection('albums').where({ approved: true, artist: re }).limit(100).get(),
      ])
      const filtered = dedupe(res1.data.concat(res2.data)).filter(a=>!genre||(a.genres||[]).includes(genre)).filter(a=>{if(!year)return true;const y=a.releaseYear;return year==='2010s'?y>=2010&&y<=2017:year==='2000s'?y>=2000&&y<=2009:y===parseInt(year)}).filter(a=>!month||!year||!/^\d{4}$/.test(String(year))||String(a.releaseDate||'').slice(5,7)===String(month).padStart(2,'0'))
      const sorted = filtered.sort((a,b)=>String(a.releaseDate||'9999-99-99').localeCompare(String(b.releaseDate||'9999-99-99')))
      const start=(page-1)*pageSize, list=sorted.slice(start,start+pageSize)
      return { success:true, list, total:sorted.length, page, pageSize, debug:{year,sortBy,matched:sorted.length,returned:list.length} }
    }

    if (artistId) {
      const artistKey = String(artistId)
      const [coCreatorRes, legacyRes] = await Promise.all([
        db.collection('albums').where({ approved: true, artistIds: _.all([artistKey]) }).limit(100).get(),
        db.collection('albums').where({ approved: true, neteaseArtistId: artistKey }).limit(100).get(),
      ])
      const sorted=sortList(dedupe(coCreatorRes.data.concat(legacyRes.data)),sortBy), start=(page-1)*pageSize
      return { success:true, list:sorted.slice(start,start+pageSize), total:sorted.length, page, pageSize }
    }

    const filters = { approved: true }
    if (genre) filters.genres = _.all([genre])
    else if (year) filters.releaseYear = year==='2010s'?_.gte(2010).and(_.lte(2017)):year==='2000s'?_.gte(2000).and(_.lte(2009)):_.eq(parseInt(year))
    if (month && year && /^\d{4}$/.test(String(year))) filters.releaseDate = db.RegExp({ regexp:`^${year}-${String(month).padStart(2,'0')}-`, options:'' })
    const query=db.collection('albums').where(filters)
    const total=(await query.count()).total
    const field=sortBy==='releaseYear'?'releaseDate':'avgScore'
    const listResult=await query.orderBy(field, sortBy==='releaseYear'?'asc':'desc').skip((page-1)*pageSize).limit(pageSize).get()
    return { success:true, list:listResult.data, total, page, pageSize }
  } catch(err) { return { success:false, error:err.message, debug:{year,sortBy,page,pageSize} } }
}
