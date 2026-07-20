const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'

exports.main = async event => {
  const keyword = String(event.name || event.keyword || '').trim()
  if (!keyword || keyword.length > 80) return { success:false, error:'请输入有效的专辑名称' }

  try {
    const payload = {
      comm: { ct:'19', cv:'1859', uin:'0' },
      req: {
        module:'music.search.SearchCgiService',
        method:'DoSearchForQQMusicDesktop',
        param:{ query:keyword, search_type:2, num_per_page:20, page_num:1 },
      },
    }
    const raw = await postJson(MUSICU_URL, payload)
    const list = ((((raw || {}).req || {}).data || {}).body || {}
    const albumRows = (((list.album || {}).list) || [])
    const results = albumRows.map(row => normalizeAlbum(row && (row.album || row))).filter(Boolean)
    const wanted = normalize(keyword)
    const exact = results.filter(item => normalize(item.title) === wanted)

    return {
      success:true,
      keyword,
      exactMatch:exact.length ? exact[0] : null,
      exactMatchCount:exact.length,
      results:results.slice(0,20),
    }
  } catch (e) {
    console.error('searchQQAlbum failed:', e)
    return { success:false, error:e && e.message ? e.message : 'QQ音乐查询失败' }
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

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body))
    const target = new URL(url)
    const req = https.request({
      protocol:target.protocol,
      hostname:target.hostname,
      port:target.port || 443,
      path:target.pathname + target.search,
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Content-Length':data.length,
        'User-Agent':'Mozilla/5.0',
        'Referer':'https://y.qq.com/',
        'Origin':'https://y.qq.com',
      },
      timeout:15000,
    }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(text)) }
        catch (_) { reject(new Error('QQ音乐返回格式异常')) }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('QQ音乐请求超时')) })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}
