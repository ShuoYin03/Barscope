const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db  = cloud.database()
const _   = db.command
const COL = 'crawlerStatus'
const DOC = 'singleton'

const ADMIN_ACTIONS  = new Set(['trigger', 'clearLog', 'abort'])
const SERVER_ACTIONS = new Set(['claimRun', 'updateProgress', 'appendLog', 'completeRun', 'failRun', 'abortRun', 'isAborted'])

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { action }  = event
  try {
    if (ADMIN_ACTIONS.has(action)) {
      if (!OPENID) return { success: false, error: '无权限' }
      const { data: admins } = await db.collection('users').where({ openId: OPENID, type: 'admin' }).limit(1).get()
      if (admins.length === 0) return { success: false, error: '无权限' }
    }
    if (action === 'getStatus') {
      let doc
      try { doc = (await db.collection(COL).doc(DOC).get()).data } catch { doc = makeDefault() }
      return { success: true, status: doc }
    }
    if (action === 'trigger') {
      const { mode = 'fission', param = '' } = event
      await upsertDoc({ status:'pending', triggeredAt:db.serverDate(), triggerType:'manual', mode, param:String(param || ''), abort:false, completedAt:null, lastRunSummary:{ newAlbums:0, newCandidates:0, errors:[] } })
      return { success:true }
    }
    if (action === 'abort') {
      let cur
      try { cur = (await db.collection(COL).doc(DOC).get()).data } catch { cur = makeDefault() }
      const st = cur.status
      if (st !== 'running' && st !== 'pending') return { success:true, noop:true }
      const p = cur.progress || {}
      const logs = Array.isArray(cur.log) ? cur.log : (Array.isArray(cur.logs) ? cur.logs : [])
      // Hard stop: status flips immediately. Old crawlerBatch responses are blocked from reviving it.
      await upsertDoc({
        status:'aborted',
        abort:true,
        completedAt:db.serverDate(),
        lastRunSummary:{ newAlbums:Number(p.albumsFound || 0), newCandidates:Number(p.candidatesFound || 0), errors:['用户中止'] },
        log:[`任务已硬中止（当前批次可能仍完成网络请求，但不会继续写入运行状态）`, ...logs].slice(0,100),
      })
      return { success:true, cancelled:'hard' }
    }
    if (action === 'clearLog') { await upsertDoc({ log:[] }); return { success:true } }
    if (action === 'claimRun') {
      let current
      try { current = (await db.collection(COL).doc(DOC).get()).data } catch { current = null }
      if (!current || current.status !== 'pending') return { success:false, error:'no pending run' }
      await db.collection(COL).doc(DOC).update({ data:{ status:'running', abort:false, progress:{ totalArtists:0, processedArtists:0, albumsFound:0, candidatesFound:0 } } })
      return { success:true, mode:current.mode || 'fission', param:current.param || '' }
    }
    if (action === 'updateProgress') {
      const { totalArtists = 0, processedArtists = 0, albumsFound = 0, candidatesFound = 0 } = event
      const cur = await safeGet()
      if (cur.status === 'aborted') return { success:true, ignored:true }
      await db.collection(COL).doc(DOC).update({ data:{ progress:{ totalArtists, processedArtists, albumsFound, candidatesFound } } })
      return { success:true }
    }
    if (action === 'appendLog') {
      const { line = '' } = event
      const cur = await safeGet()
      if (cur.status === 'aborted') return { success:true, ignored:true }
      const ts = new Date().toISOString().slice(11,19)
      await db.collection(COL).doc(DOC).update({ data:{ log:_.push({ each:[`[${ts}] ${line}`], slice:-50 }) } })
      return { success:true }
    }
    if (action === 'completeRun') {
      const cur = await safeGet()
      if (cur.status === 'aborted') return { success:true, ignored:true }
      const { newAlbums = 0, newCandidates = 0, errors = [] } = event
      await db.collection(COL).doc(DOC).update({ data:{ status:'done', completedAt:db.serverDate(), lastRunSummary:{ newAlbums, newCandidates, errors } } })
      return { success:true }
    }
    if (action === 'failRun') {
      const cur = await safeGet()
      if (cur.status === 'aborted') return { success:true, ignored:true }
      const { error = '' } = event
      await db.collection(COL).doc(DOC).update({ data:{ status:'error', completedAt:db.serverDate(), lastRunSummary:{ newAlbums:0, newCandidates:0, errors:[error] } } })
      return { success:true }
    }
    if (action === 'isAborted') {
      const cur = await safeGet()
      return { success:true, abort:cur.status === 'aborted' || !!cur.abort }
    }
    if (action === 'abortRun') {
      const { newAlbums = 0, newCandidates = 0 } = event
      await db.collection(COL).doc(DOC).update({ data:{ status:'aborted', abort:true, completedAt:db.serverDate(), lastRunSummary:{ newAlbums, newCandidates, errors:['用户中止'] } } })
      return { success:true }
    }
    return { success:false, error:'未知 action' }
  } catch (err) { return { success:false, error:err.message } }
}
async function safeGet(){ try{return (await db.collection(COL).doc(DOC).get()).data || makeDefault()}catch{return makeDefault()} }
async function upsertDoc(fields) { try { await db.collection(COL).doc(DOC).update({ data:fields }) } catch { await db.collection(COL).add({ data:Object.assign(makeDefault(), { _id:DOC }, fields) }) } }
function makeDefault() { return { _id:DOC, status:'idle', triggeredAt:null, completedAt:null, triggerType:'manual', mode:'fission', param:'', abort:false, progress:{ totalArtists:0, processedArtists:0, albumsFound:0, candidatesFound:0 }, lastRunSummary:{ newAlbums:0, newCandidates:0, errors:[] }, log:[] } }
