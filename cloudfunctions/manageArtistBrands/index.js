const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const ALLOWED_ROLES = new Set(['rapper', 'producer', 'label'])
const SUGGESTIONS_COL = 'artist_role_suggestions'

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  const action = String(event.action || '')

  if (action === 'submit_role_suggestion') return submitRoleSuggestion(event, OPENID)

  const admin = await isAdmin(OPENID)
  if (!admin) return { success:false, error:'unauthorized' }

  if (action === 'update') return updateArtistProfile(event)
  if (action === 'bulk_update_roles') return bulkUpdateRoles(event)
  if (action === 'get_roles_map') return getRolesMap(event)
  if (action === 'list_role_suggestions') return listRoleSuggestions()
  if (action === 'review_role_suggestion') return reviewRoleSuggestion(event, OPENID)
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

async function ensureSuggestionsCollection() {
  try { await db.collection(SUGGESTIONS_COL).limit(1).get() }
  catch (e) {
    const msg = String(e && (e.errMsg || e.message) || '')
    if (!msg.includes('DATABASE_COLLECTION_NOT_EXIST') && !msg.includes('collection not exists') && !msg.includes('Db or Table not exist')) throw e
    try { await db.createCollection(SUGGESTIONS_COL) } catch (x) {}
  }
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

async function getRolesMap(event) {
  const ids = Array.isArray(event.artistDocIds) ? event.artistDocIds.map(x => String(x || '').trim()).filter(Boolean) : []
  const out = {}
  if (!ids.length) return { success:true, rolesMap:out }
  for (let i = 0; i < ids.length; i += 100) {
    const res = await db.collection('artist_candidates').where({ _id: _.in(ids.slice(i, i + 100)) }).field({ _id:true, roles:true }).get()
    ;(res.data || []).forEach(x => { out[x._id] = cleanRoles(x.roles) })
  }
  return { success:true, rolesMap:out }
}

async function submitRoleSuggestion(event, openId) {
  if (!openId) return { success:false, error:'请先登录' }
  const artistId = String(event.artistId || '').trim()
  const artistName = String(event.artistName || '').trim()
  const roles = cleanRoles(event.roles)
  if (!artistId) return { success:false, error:'artistId required' }
  await ensureSuggestionsCollection()

  const artistRes = await db.collection('artist_candidates').where({ artistId: Number(artistId), status:'approved' }).limit(1).get()
  if (!artistRes.data.length) return { success:false, error:'未找到该艺人' }
  const artist = artistRes.data[0]
  const currentRoles = cleanRoles(artist.roles)
  if (JSON.stringify(currentRoles.slice().sort()) === JSON.stringify(roles.slice().sort())) return { success:false, error:'身份没有变化' }

  const existing = await db.collection(SUGGESTIONS_COL).where({ artistId, submittedBy:openId, status:'pending' }).limit(1).get()
  if (existing.data.length) {
    await db.collection(SUGGESTIONS_COL).doc(existing.data[0]._id).update({ data:{ roles, previousRoles:currentRoles, artistName:artist.artistName || artistName, updatedAt:db.serverDate() } })
    return { success:true, pending:true, updatedExisting:true }
  }

  await db.collection(SUGGESTIONS_COL).add({ data:{
    artistDocId:artist._id,
    artistId,
    artistName:artist.artistName || artistName,
    previousRoles:currentRoles,
    roles,
    status:'pending',
    submittedBy:openId,
    createdAt:db.serverDate(),
    updatedAt:db.serverDate(),
  } })
  return { success:true, pending:true }
}

async function listRoleSuggestions() {
  await ensureSuggestionsCollection()
  const res = await db.collection(SUGGESTIONS_COL).where({ status:'pending' }).orderBy('createdAt','asc').limit(200).get()
  return { success:true, list:res.data || [], total:(res.data || []).length }
}

async function reviewRoleSuggestion(event, openId) {
  const suggestionId = String(event.suggestionId || '').trim()
  const decision = String(event.decision || '')
  if (!suggestionId || !['approve','reject'].includes(decision)) return { success:false, error:'invalid review request' }
  await ensureSuggestionsCollection()
  const doc = await db.collection(SUGGESTIONS_COL).doc(suggestionId).get()
  const suggestion = doc.data
  if (!suggestion || suggestion.status !== 'pending') return { success:false, error:'申请已处理或不存在' }

  if (decision === 'approve') {
    const roles = cleanRoles(suggestion.roles)
    let artistDocId = String(suggestion.artistDocId || '')
    if (!artistDocId) {
      const artistRes = await db.collection('artist_candidates').where({ artistId:Number(suggestion.artistId), status:'approved' }).limit(1).get()
      if (!artistRes.data.length) return { success:false, error:'未找到该艺人' }
      artistDocId = artistRes.data[0]._id
    }
    await db.collection('artist_candidates').doc(artistDocId).update({ data:{ roles, rolesUpdatedAt:db.serverDate(), rolesUpdatedBy:openId } })
  }

  await db.collection(SUGGESTIONS_COL).doc(suggestionId).update({ data:{ status:decision === 'approve' ? 'approved' : 'rejected', reviewedAt:db.serverDate(), reviewedBy:openId } })
  return { success:true, decision, roles:cleanRoles(suggestion.roles), artistDocId:suggestion.artistDocId || '' }
}
