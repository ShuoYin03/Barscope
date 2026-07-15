const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()

  try {
    const { data } = await db.collection('users').where({ openId: OPENID }).get()

    if (data.length === 0) {
      return { success: false, error: 'user not found' }
    }

    const user = data[0]
    const urlMap = await resolveCloudUrls([user.avatarUrl, user.coverUrl])
    user.avatarUrl = applyResolvedUrl(user.avatarUrl, urlMap) || ''
    user.coverUrl = applyResolvedUrl(user.coverUrl, urlMap) || ''

    return { success: true, user }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// cloud:// fileIDs (from wx.cloud.uploadFile) don't render directly in <image src> under every
// render context, so any avatar/cover pulled from storage needs resolving to a temp HTTPS URL
// before it's sent to the client. Temp URLs expire, so this happens fresh on every read.
async function resolveCloudUrls(urls) {
  const targets = Array.from(new Set(urls.filter(u => typeof u === 'string' && u.startsWith('cloud://'))))
  if (!targets.length) return new Map()
  try {
    const res = await cloud.getTempFileURL({ fileList: targets })
    const map = new Map()
    ;(res.fileList || []).forEach(f => { if (f.status === 0 && f.tempFileURL) map.set(f.fileID, f.tempFileURL) })
    return map
  } catch (e) {
    console.warn('resolveCloudUrls failed:', e.message)
    return new Map()
  }
}
function applyResolvedUrl(url, map) {
  return (url && map.get(url)) || url
}
