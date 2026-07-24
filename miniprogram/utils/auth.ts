const LOGGED_OUT_KEY = 'soundive_logged_out'

export const markLoggedIn = () => {
  wx.removeStorageSync(LOGGED_OUT_KEY)
}

export const logout = () => {
  wx.setStorageSync(LOGGED_OUT_KEY, true)
  const app = getApp<IAppOption>()
  app.globalData.userInfo = null
  app.globalData.userType = 'normal'
  app.globalData.isAdmin = false
}

export const initAuth = (): Promise<void> =>
  new Promise((resolve) => {
    if (wx.getStorageSync(LOGGED_OUT_KEY)) { resolve(); return }
    if (!wx.cloud) { resolve(); return }
    wx.cloud.callFunction({
      name: 'getUserInfo',
      success: (res: any) => {
        const app    = getApp<IAppOption>()
        const result = res.result
        if (result?.success && result.user) {
          const u = result.user
          app.globalData.userInfo = {
            openId:      u.openId,
            nickName:    u.nickName,
            avatarUrl:   u.avatarUrl  || '',
            type:        u.type,
            bio:         u.bio        || '',
            reviewCount: u.reviewCount || 0,
          }
          app.globalData.userType = u.type  ?? 'normal'
          app.globalData.isAdmin  = u.type  === 'admin'
        }
        resolve()
      },
      fail: () => resolve(),
    })
  })

export const isCritic = (): boolean =>
  getApp<IAppOption>().globalData.userType === 'critic'

export const isLoggedIn = (): boolean =>
  !!getApp<IAppOption>().globalData.userInfo
