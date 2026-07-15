const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()

  try {
    const { data } = await db.collection('users').where({ openId: OPENID }).get()
    const nickName = String(event.nickName || '').trim()
    const avatarUrl = String(event.avatarUrl || '').trim()
    const coverUrl = String(event.coverUrl || '').trim()
    const bio = String(event.bio || '').trim().slice(0, 100)

    let user
    if (data.length > 0) {
      const existing = data[0]
      const patch = {}
      if (nickName && nickName !== existing.nickName) patch.nickName = nickName
      if (avatarUrl && avatarUrl !== existing.avatarUrl) patch.avatarUrl = avatarUrl
      if (coverUrl && coverUrl !== existing.coverUrl) patch.coverUrl = coverUrl
      if (bio !== (existing.bio || '')) patch.bio = bio
      if (Object.keys(patch).length) {
        await db.collection('users').doc(existing._id).update({ data: patch })
        Object.assign(existing, patch)
      }
      user = existing
    } else {
      // First time login — create user
      const newUser = {
        openId: OPENID,
        nickName: nickName || '说唱迷',
        avatarUrl: avatarUrl || '',
        coverUrl: coverUrl || '',
        type: 'normal',
        bio: bio || '',
        reviewCount: 0,
        joinedAt: db.serverDate(),
      }
      const result = await db.collection('users').add({ data: newUser })
      user = { _id: result._id, ...newUser }
    }

    const urlMap = await resolveCloudUrls([user.avatarUrl, user.coverUrl])
    user.avatarUrl = applyResolvedUrl(user.avatarUrl, urlMap) || ''
    user.coverUrl = applyResolvedUrl(user.coverUrl, urlMap) || ''

    return { success: true, user, isNew: data.length === 0 }
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
