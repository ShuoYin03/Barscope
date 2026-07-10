const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!(await isAdmin(OPENID))) return { success:false, error:'unauthorized' }
  const action = String(event.action || '')
  if (action === 'update') return updateArtistBrands(event)
  return { success:false, error:'unknown action' }
}

async function isAdmin(openId) {
  if (!openId) return false
  const r = await db.collection('users').where({ openId, type:'admin' }).limit(1).get()
  return r.data.length > 0
}

async function updateArtistBrands(event) {
  const artistDocId = String(event.artistDocId || '').trim()
  if (!artistDocId) return { success:false, error:'artistDocId required' }
  const seen = new Set()
  const brands = (Array.isArray(event.brands) ? event.brands : [])
    .map(x => String(x || '').trim())
    .filter(x => x && !seen.has(x) && seen.add(x))
    .slice(0, 10)
  await db.collection('artist_candidates').doc(artistDocId).update({ data:{
    brand: brands[0] || '',
    brands,
    brandUpdatedAt: db.serverDate(),
    brandUpdatedBy: cloud.getWXContext().OPENID,
  } })
  return { success:true, brands }
}
