const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  const { OPENID } = cloud.getWXContext()
  if (!(await isAdmin(OPENID))) return { success:false, error:'unauthorized' }
  const action = event.action || 'list'
  if (action === 'list') return list()
  if (action === 'stats') return stats()
  return { success:false, error:'unknown action' }
}
async function isAdmin(openId){ if(!openId)return false; const r=await db.collection('users').where({openId,type:'admin'}).limit(1).get(); return r.data.length>0 }
async function list(){ const r=await db.collection('crawlerReports').orderBy('createdAt','desc').limit(60).get(); return {success:true,list:r.data,total:r.data.length} }
async function stats(){ const r=await db.collection('crawlerReports').count(); return {success:true,total:r.total} }
