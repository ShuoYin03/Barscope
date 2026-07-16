const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const ALLOWED_ROLES = new Set(['rapper', 'producer', 'label'])

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!(await isAdmin(OPENID))) return { success:false, error:'unauthorized' }
  const action = String(event.action || '')
  if (action === 'update') return updateArtistProfile(event)
  return { success:false, error:'unknown action' }
}

async function isAdmin(openId) {
  if (!openId) return false
  const r = await db.collection('users').where({ openId, type:'admin' }).limit(1).get()
  return r.data.length > 0
}

function cleanUnique(values, limit) {
  const seen = new Set()
  return (Array.isArray(values) ? values : [])
    .map(x => String(x || '').trim())
    .filter(x => x && !seen.has(x) && seen.add(x))
    .slice(0, limit)
}

async function updateArtistProfile(event) {
  const artistDocId = String(event.artistDocId || '').trim()
  if (!artistDocId) return { success:false, error:'artistDocId required' }

  const brands = cleanUnique(event.brands, 10)
  const roles = cleanUnique(event.roles, 3).filter(role => ALLOWED_ROLES.has(role))
  const openId = cloud.getWXContext().OPENID

  await db.collection('artist_candidates').doc(artistDocId).update({ data:{
    brand: brands[0] || '',
    brands,
    roles,
    brandUpdatedAt: db.serverDate(),
    brandUpdatedBy: openId,
    rolesUpdatedAt: db.serverDate(),
    rolesUpdatedBy: openId,
  } })

  return { success:true, brands, roles }
}