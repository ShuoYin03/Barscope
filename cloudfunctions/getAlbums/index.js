const cloud = require('wx-server-sdk')
const { pinyin } = require('pinyin-pro')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const UNRATED_LETTER_ORDER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('')

function isAllYear(year) { return year === 'ALL' }
function sortList(list, sortBy) { const field=sortBy==='releaseYear'?'releaseDate':'avgScore'; const direction=sortBy==='releaseYear'?1:-1; return list.slice().sort((a,b)=>{const av=a[field]||(direction===1?'9999-99-99':0); const bv=b[field]||(direction===1?'9999-99-99':0); return direction*(av>bv?1:av<bv?-1:0)}) }
function isValidAlbum(a){ const title=String(a&&a.title||'').trim(); const cover=String(a&&a.coverUrl||'').trim(); if(!title||!cover)return false; if(/^[-_—–·.\s]+$/.test(title))return false; if(title.length<=1&&!/[\u4e00-\u9fa5A-Za-z0-9]/.test(title))return false; return true }
function filterValid(list){ return (list||[]).filter(isValidAlbum) }
function normalizeDedupeTitle(v){return String(v||'').trim().toLowerCase().replace(/[\s\u3000《》「」『』【】\[\]()（）.,，。:：;；!！?？'"“”‘’_\-]/g,'')}
function dedupeKey(a){const sourceId=String(a&&a.sourceId||'').trim();if(sourceId)return`source:${sourceId}`;const title=normalizeDedupeTitle(a&&a.title);const release=String(a&&a.releaseDate||'').trim()||String(a&&a.releaseYear||'').trim();const tracks=Number(a&&a.trackCount||0);if(title&&release&&tracks)return`semantic:${title}|${release}|${tracks}`;return`legacy:${title}|${String(a&&a.artist||'').toLowerCase()}`}
function dedupe(list){const seenId={},seenKey={},merged=[];filterValid(list).forEach(a=>{if(!a||seenId[a._id])return;const key=dedupeKey(a);if(seenKey[key])return;seenId[a._id]=true;seenKey[key]=true;merged.push(a)});return merged}
function applyPeriodFilters(filters,year,month){if(year&&!isAllYear(year))filters.releaseYear=year==='2010s'?_.gte(2010).and(_.lte(2017)):year==='2000s'?_.gte(2000).and(_.lte(2009)):_.eq(parseInt(year));if(month&&year&&/^\d{4}$/.test(String(year)))filters.releaseDate=db.RegExp({regexp:`^${year}-${String(month).padStart(2,'0')}-`,options:''});return filters}
function baseFilters(genre,year,month,releaseType){const filters={approved:true};if(genre)filters.genres=_.all([genre]);if(releaseType)filters.releaseType=releaseType;return applyPeriodFilters(filters,year,month)}
function ratedFilters(genre,year,month,releaseType){return Object.assign(baseFilters(genre,year,month,releaseType),{avgScore:_.gt(0),reviewCount:_.gt(0)})}
function unratedFilters(genre,year,month,releaseType){return Object.assign(baseFilters(genre,year,month,releaseType),{avgScore:_.lte(0)})}
function letterRegExp(letter){const l=String(letter||'').toUpperCase();return l==='#'?db.RegExp({regexp:'^[^A-Za-z]',options:''}):db.RegExp({regexp:`^${l}`,options:'i'})}
function normalize(v){return String(v||'').trim().toLowerCase().replace(/[\s._\-·'’/]/g,'')}
function pinyinForms(v){try{const parts=pinyin(String(v||''),{toneType:'none',type:'array'});return[normalize(v),normalize(parts.join('')),normalize(parts.map(x=>x.charAt(0)).join(''))]}catch(e){return[normalize(v)]}}
function hasCJK(v){return /[一-鿿]/.test(String(v||''))}
function pinyinSyllables(v){try{return pinyin(String(v||''),{toneType:'none',type:'array'}).map(s=>normalize(s))}catch(e){return[]}}
function syllableSubsequenceMatch(targetSyllables,querySyllables){if(!querySyllables.length)return false;for(let i=0;i<=targetSyllables.length-querySyllables.length;i++){let ok=true;for(let j=0;j<querySyllables.length;j++){if(targetSyllables[i+j]!==querySyllables[j]){ok=false;break}}if(ok)return true}return false}
function fuzzyMatch(v,q){const needle=normalize(q);if(needle&&pinyinForms(v).some(x=>x.includes(needle)))return true;if(hasCJK(q)&&syllableSubsequenceMatch(pinyinSyllables(v),pinyinSyllables(q)))return true;return false}
function relevance(a,q){const n=normalize(q),title=normalize(a.title),artist=normalize(a.artist),primary=normalize(a.primaryArtist);const titleForms=pinyinForms(a.title),artistForms=pinyinForms(`${a.artist||''} ${a.primaryArtist||''}`);if(title===n)return 100;if(title.startsWith(n))return 90;if(title.includes(n))return 80;if(titleForms.some(x=>x.startsWith(n)))return 75;if(titleForms.some(x=>x.includes(n)))return 70;if(artist===n||primary===n)return 60;if(artist.startsWith(n)||primary.startsWith(n))return 55;if(artist.includes(n)||primary.includes(n))return 50;if(artistForms.some(x=>x.startsWith(n)))return 45;if(artistForms.some(x=>x.includes(n)))return 40;if(hasCJK(q)){const qSyl=pinyinSyllables(q);if(syllableSubsequenceMatch(pinyinSyllables(a.title),qSyl))return 65;if(syllableSubsequenceMatch(pinyinSyllables(`${a.artist||''} ${a.primaryArtist||''}`),qSyl))return 35}return 0}

async function getValidPage(query,{orderBy,start,pageSize}){const out=[];let offset=start,guard=0;while(out.length<pageSize&&guard<8){let q=query;(orderBy||[]).forEach(o=>{q=q.orderBy(o[0],o[1])});const r=await q.skip(offset).limit(pageSize).get(),batch=r.data||[];out.push(...filterValid(batch));if(batch.length<pageSize)break;offset+=pageSize;guard++}return out.slice(0,pageSize)}
async function fetchAllApprovedAlbums(cap=4000){const query=db.collection('albums').where({approved:true});const total=Math.min(Number((await query.count()).total||0),cap),pageSize=100,batches=[];for(let start=0;start<total;start+=pageSize)batches.push(query.skip(start).limit(pageSize).get());return(await Promise.all(batches)).flatMap(x=>x.data||[])}
async function fetchUnratedAlphabeticalSlice({genre,start,pageSize,releaseType}){const counts=await Promise.all(UNRATED_LETTER_ORDER.map(async letter=>{const filters=Object.assign(unratedFilters(genre,'ALL','',releaseType),{title:letterRegExp(letter)});return{letter,total:Number((await db.collection('albums').where(filters).count()).total||0)}}));const list=[];let cursor=0;for(const{letter,total}of counts){if(list.length>=pageSize)break;const groupEnd=cursor+total;if(start>=groupEnd){cursor=groupEnd;continue}const withinGroupStart=Math.max(0,start-cursor),need=pageSize-list.length,filters=Object.assign(unratedFilters(genre,'ALL','',releaseType),{title:letterRegExp(letter)});list.push(...await getValidPage(db.collection('albums').where(filters),{orderBy:[['title','asc'],['releaseDate','desc']],start:withinGroupStart,pageSize:need}));cursor=groupEnd}return list}
async function fetchPartitionedPage({genre,year,month,page,pageSize,releaseType}){const ratedQuery=db.collection('albums').where(ratedFilters(genre,year,month,releaseType)),unratedQuery=db.collection('albums').where(unratedFilters(genre,year,month,releaseType));const[ratedCountRes,unratedCountRes]=await Promise.all([ratedQuery.count(),unratedQuery.count()]);const ratedTotal=Number(ratedCountRes.total||0),unratedTotal=Number(unratedCountRes.total||0),total=ratedTotal+unratedTotal,start=(page-1)*pageSize;let list=[];if(start<ratedTotal){const ratedNeed=Math.min(pageSize,ratedTotal-start);list=list.concat(await getValidPage(ratedQuery,{orderBy:[['avgScore','desc'],['releaseDate','desc']],start,pageSize:ratedNeed}));if(list.length<pageSize){const need=pageSize-list.length;list=list.concat(isAllYear(year)?await fetchUnratedAlphabeticalSlice({genre,start:0,pageSize:need,releaseType}):await getValidPage(unratedQuery,{orderBy:[['releaseDate','desc'],['title','asc']],start:0,pageSize:need}))}}else{const unratedStart=start-ratedTotal;list=isAllYear(year)?await fetchUnratedAlphabeticalSlice({genre,start:unratedStart,pageSize,releaseType}):await getValidPage(unratedQuery,{orderBy:[['releaseDate','desc'],['title','asc']],start:unratedStart,pageSize})}list=dedupe(list);return{success:true,list,total,page,pageSize,debug:{mode:'scoredThenUnrated',year:year||'',month:month||'',ratedTotal,unratedTotal,returned:list.length,start,unratedOrder:isAllYear(year)?'A-Z-#':'releaseDate-desc'}}}
async function fetchUnratedLetter({genre,letter,page,pageSize,releaseType}){const filters=Object.assign(unratedFilters(genre,'ALL','',releaseType),{title:letterRegExp(letter)}),query=db.collection('albums').where(filters),rawTotal=(await query.count()).total,start=(page-1)*pageSize,list=dedupe(await getValidPage(query,{orderBy:[['title','asc'],['releaseDate','desc']],start,pageSize}));return{success:true,list,total:rawTotal,page,pageSize,debug:{mode:'unratedLetter',letter,returned:list.length,start,validOnly:true}}}

async function searchAlbums({keyword,genre,year,month,page,pageSize,releaseType}){
  const re=db.RegExp({regexp:keyword,options:'i'})
  const direct=await Promise.all([
    db.collection('albums').where({approved:true,title:re}).limit(100).get(),
    db.collection('albums').where({approved:true,artist:re}).limit(100).get(),
    db.collection('albums').where({approved:true,primaryArtist:re}).limit(100).get(),
  ])
  const directList=direct.flatMap(x=>x.data||[])
  let fuzzyList=[]
  let matchedArtistNames=[]
  if (!directList.length) {
    try {
      const [artistRes,allAlbums]=await Promise.all([
        db.collection('artist_candidates').where({status:'approved'}).field({_id:true,artistId:true,artistName:true}).limit(1000).get(),
        fetchAllApprovedAlbums(),
      ])
      const matchedArtists=(artistRes.data||[]).filter(a=>a.artistId&&fuzzyMatch(a.artistName,keyword)).slice(0,50)
      const matchedIds=new Set(matchedArtists.map(a=>String(a.artistId)))
      matchedArtistNames=matchedArtists.map(x=>x.artistName)
      fuzzyList=allAlbums.filter(a=>fuzzyMatch(a.title,keyword)||fuzzyMatch(a.artist,keyword)||fuzzyMatch(a.primaryArtist,keyword)||(Array.isArray(a.artistIds)&&a.artistIds.some(id=>matchedIds.has(String(id))))||matchedIds.has(String(a.neteaseArtistId||'')))
    } catch(e) {
      console.error('searchAlbums fuzzy pass failed, falling back to direct matches only:', e)
    }
  }
  let filtered=dedupe(directList.concat(fuzzyList))
  filtered=filtered.filter(a=>!genre||(a.genres||[]).includes(genre)).filter(a=>!releaseType||a.releaseType===releaseType).filter(a=>{if(!year||isAllYear(year))return true;const y=a.releaseYear;return year==='2010s'?y>=2010&&y<=2017:year==='2000s'?y>=2000&&y<=2009:y===parseInt(year)}).filter(a=>!month||!year||!/^\d{4}$/.test(String(year))||String(a.releaseDate||'').slice(5,7)===String(month).padStart(2,'0'))
  const sorted=filtered.sort((a,b)=>(relevance(b,keyword)-relevance(a,keyword))||(Number(b.avgScore||0)-Number(a.avgScore||0))||String(b.releaseDate||'').localeCompare(String(a.releaseDate||'')))
  const start=(page-1)*pageSize,list=sorted.slice(start,start+pageSize)
  return{success:true,list,total:sorted.length,page,pageSize,debug:{mode:'liveFuzzySearch',keyword,matchedArtists:matchedArtistNames,returned:list.length}}
}

exports.main=async event=>{const{genre,year,month,artistId,id,unratedLetter,releaseType}=event;const page=Number(event.page||1),pageSize=Math.min(Number(event.pageSize||20),100),keyword=String(event.keyword||'').trim(),sortBy=event.sortBy||'avgScore';try{if(id)return{success:true,album:(await db.collection('albums').doc(id).get()).data};if(keyword)return await searchAlbums({keyword,genre,year,month,page,pageSize,releaseType});if(isAllYear(year)&&unratedLetter)return await fetchUnratedLetter({genre,letter:unratedLetter,page,pageSize,releaseType});if(isAllYear(year)||sortBy==='allRatedFirst'||sortBy==='yearRatedFirst')return await fetchPartitionedPage({genre,year,month,page,pageSize,releaseType});if(artistId){const artistKey=String(artistId),[ownerRes,legacyRes]=await Promise.all([db.collection('albums').where({approved:true,ownerArtistIds:_.all([artistKey])}).limit(100).get(),db.collection('albums').where({approved:true,ownerArtistIds:_.exists(false),neteaseArtistId:artistKey}).limit(100).get()]),sorted=sortList(dedupe(ownerRes.data.concat(legacyRes.data)),sortBy),start=(page-1)*pageSize;return{success:true,list:sorted.slice(start,start+pageSize),total:sorted.length,page,pageSize}}const filters=baseFilters(genre,year,month,releaseType),query=db.collection('albums').where(filters),total=(await query.count()).total,field=sortBy==='releaseYear'?'releaseDate':'avgScore',listResult=await query.orderBy(field,sortBy==='releaseYear'?'asc':'desc').skip((page-1)*pageSize).limit(pageSize).get();return{success:true,list:dedupe(listResult.data),total,page,pageSize}}catch(err){return{success:false,error:err.message,debug:{year,sortBy,page,pageSize,unratedLetter,keyword}}}}