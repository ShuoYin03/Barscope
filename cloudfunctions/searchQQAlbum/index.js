const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const LEGACY_SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const QQ_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Referer':'https://y.qq.com/',
  'Origin':'https://y.qq.com',
}

exports.main = async event => {
  const keyword = String(event.name || event.keyword || '').trim()
  if (!keyword || keyword.length > 80) return { success:false, error:'请输入有效的专辑名称' }

  try {
    const primary = await searchMusicu(keyword)
    if (primary.length) return buildResponse(keyword, primary, 'musicu')

    const legacy = await searchLegacy(keyword)
    return buildResponse(keyword, legacy, 'legacy')
  } catch (e) {
    console.error('searchQQAlbum failed:', e)
    return { success:false, error:e && e.message ? e.message : 'QQ音乐查询失败' }
  }
}

async function searchMusicu(keyword) {
  const payload = {
    comm: { ct:'19', cv:'1859', uin:'0' },
    req: {
      module:'music.search.SearchCgiService',
      method:'DoSearchForQQMusicDesktop',
      param:{ query:keyword, search_type:2, num_per_page:20, page_num:1 },
    },
  }
  const raw = await postJson(MUSICU_URL, payload, QQ_HEADERS)
  const body = (((raw || {}).req || {}).data || {}).body || {}
  const rows = ((body.album || {}).list) || []
  return rows.map(row => normalizeAlbum(row && (row.album || row))).filter(Boolean)
}

async function searchLegacy(keyword) {
  const url = `${LEGACY_SEARCH_URL}?${new URLSearchParams({
    ct:'24', qqmusic_ver:'1298', new_json:'1', remoteplace:'txt.yqq.album', searchid:String(Date.now()),
    t:'8', aggr:'1', cr:'1', catZhida:'1', lossless:'0', flag_qc:'0', p:'1', n:'20', w:keyword,
    g_tk:'5381', loginUin:'0', hostUin:'0', format:'json', inCharset:'utf8', outCharset:'utf-8', notice:'0', platform:'yqq.json', needNewCode:'0'
  }).toString()}`
  const raw = await getJsonFlexible(url, QQ_HEADERS)
  const rows = (((raw || {}).data || {}).album || {}).list || []
  return rows.map(normalizeLegacyAlbum).filter(Boolean)
}

function buildResponse(keyword, results, provider) {
  const wanted = normalize(keyword)
  const exact = results.filter(item => normalize(item.title) === wanted)
  return {
    success:true,
    keyword,
    provider,
    exactMatch:exact.length ? exact[0] : null,
    exactMatchCount:exact.length,
    results:results.slice(0,20),
  }
}

function normalizeAlbum(album) {
  if (!album || typeof album !== 'object') return null
  const title = String(album.albumName || album.album_name || album.title || album.name || '').trim()
  const albumMid = String(album.albumMID || album.album_mid || album.mid || '').trim()
  if (!title || !albumMid) return null
  const albumId = String(album.albumID || album.album_id || album.id || '').trim()
  const singerRows = album.singerList || album.singer_list || album.singer || []
  const singers = (Array.isArray(singerRows) ? singerRows : [singerRows]).map(s => ({
    name:String((s && (s.name || s.singerName || s.singer_name)) || '').trim(),
    mid:String((s && (s.mid || s.singerMID || s.singer_mid)) || '').trim(),
  })).filter(s => s.name || s.mid)
  return albumResult(title, albumMid, albumId, singers)
}

function normalizeLegacyAlbum(album) {
  if (!album || typeof album !== 'object') return null
  const title = String(album.albumName || album.album_name || album.name || '').replace(/<[^>]+>/g,'').trim()
  const albumMid = String(album.albumMID || album.album_mid || album.mid || '').trim()
  if (!title || !albumMid) return null
  const albumId = String(album.albumID || album.album_id || album.id || '').trim()
  let singerRows = album.singer || album.singerList || album.singer_list || []
  if (!Array.isArray(singerRows)) singerRows = [singerRows]
  let singers = singerRows.map(s => ({
    name:String((s && (s.name || s.singerName || s.singer_name)) || '').replace(/<[^>]+>/g,'').trim(),
    mid:String((s && (s.mid || s.singerMID || s.singer_mid)) || '').trim(),
  })).filter(s => s.name || s.mid)
  if (!singers.length) {
    const name = String(album.singerName || album.singer_name || '').trim()
    const mid = String(album.singerMID || album.singer_mid || '').trim()
    if (name || mid) singers = [{name, mid}]
  }
  return albumResult(title, albumMid, albumId, singers)
}

function albumResult(title, albumMid, albumId, singers) {
  return {
    title,
    albumMid,
    albumId,
    singers,
    artist:singers.map(s => s.name).filter(Boolean).join(' / '),
    coverUrl:`https://y.qq.com/music/photo_new/T002R800x800M000${albumMid}.jpg`,
    qqAlbumUrl:`https://y.qq.com/n/ryqq_v2/albumDetail/${albumMid}`,
  }
}

function normalize(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/explicit/gi, '')
    .replace(/[\s\-_·•.。'"“”‘’()（）\[\]【】/\\?!！？，,:：]+/g, '')
}

function postJson(url, body, headers={}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const target = new URL(url)
    const req = https.request({
      protocol:target.protocol,
      hostname:target.hostname,
      port:target.port || 443,
      path:target.pathname + target.search,
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':data.length,...headers},
      timeout:15000,
    }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(text)) }
        catch (_) { reject(new Error('QQ音乐主搜索接口返回格式异常')) }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('QQ音乐请求超时')) })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function getJsonFlexible(url, headers={}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers, timeout:15000}, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        const trimmed = text.trim()
        const jsonText = trimmed.startsWith('{') ? trimmed : trimmed.replace(/^[^(]*\(/,'').replace(/\)\s*;?$/,'')
        try { resolve(JSON.parse(jsonText)) }
        catch (_) { reject(new Error('QQ音乐备用搜索接口返回格式异常')) }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('QQ音乐备用接口请求超时')) })
    req.on('error', reject)
  })
}
