const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COL = 'feedback'

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success:false, error:'请先登录' }
  const content = String(event.content || '').trim().slice(0, 500)
  const contact = String(event.contact || '').trim().slice(0, 100)
  if (!content) return { success:false, error:'请填写内容' }

  await ensureCollection(COL)
  await db.collection(COL).add({ data:{
    content,
    contact,
    submittedBy: OPENID,
    status: 'new',
    submittedAt: db.serverDate(),
  } })
  return { success:true }
}

async function ensureCollection(name) {
  try { await db.collection(name).limit(1).get() }
  catch (e) {
    if (!isCollectionMissing(e)) throw e
    try { await db.createCollection(name) } catch (x) {
      if (!String(x && (x.errMsg || x.message) || '').includes('already exists')) throw x
    }
  }
}

function isCollectionMissing(e) {
  const msg = String(e && (e.errMsg || e.message) || '')
  return msg.includes('DATABASE_COLLECTION_NOT_EXIST') || msg.includes('collection not exists') || msg.includes('Db or Table not exist')
}
