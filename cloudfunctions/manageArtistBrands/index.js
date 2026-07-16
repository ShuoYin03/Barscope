const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const ALLOWED_ROLES = new Set(['rapper', 'producer', 'label'])

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!(await isAdmin(OPENID))) return { success:false, error:'unauthorized' }
  const action = String(event.action || '')
  if (action === 'update') return updateArtistProfile(event)
  if (action === 'bulk_update_roles') return bulkUpdateRoles(event)
  return { success:false, error:'unknown action' }
}

async function isAdmin(openId) {
  if (!openId) return false
  const r = await db.collection('users').where({ openId, type:'admin' }).limit(1).get()
  return r.data.length > 0
}

function cleanValues(values, limit) {
  const seen = new Set()
  return (Array.isArray(values) ? values : [])
    .map(x => String(x || '').trim())
    .filter(x => x && !seen.has(x) && seen.add(x))
    .slice(0, limit)
}
function cleanRoles(values) {
  return cleanValues(values, 3).map(x => x.toLowerCase()).filter(role => ALLOWED_ROLES.has(role))
}

async function updateArtistProfile(event) {
  const artistDocId = String(event.artistDocId || '').trim()
  if (!artistDocId) return { success:false, error:'artistDocId required' }
  const brands = cleanValues(event.brands, 10)
  const roles = cleanRoles(event.roles)
  const openId = cloud.getWXContext().OPENID
  await db.collection('artist_candidates').doc(artistDocId).update({ data:{
    brand: brands[0] || '', brands, roles,
    brandUpdatedAt: db.serverDate(), brandUpdatedBy: openId,
    rolesUpdatedAt: db.serverDate(), rolesUpdatedBy: openId,
  } })
  return { success:true, brands, roles }
}

async function bulkUpdateRoles(event) {
  const ids = Array.from(new Set((Array.isArray(event.artistDocIds) ? event.artistDocIds : []).map(x => String(x || '').trim()).filter(Boolean))).slice(0, 500)
  if (!ids.length) return { success:false, error:'artistDocIds required' }
  const roles = cleanRoles(event.roles)
  const openId = cloud.getWXContext().OPENID
  let updated = 0
  for (let i = 0; i < ids.length; i += 20) {
    await Promise.all(ids.slice(i, i + 20).map(async id => {
      await db.collection('artist_candidates').doc(id).update({ data:{ roles, rolesUpdatedAt: db.serverDate(), rolesUpdatedBy: openId } })
      updated += 1
    }))
  }
  return { success:true, roles, updated }
}
