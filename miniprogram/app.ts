import { initAuth } from './utils/auth'

App<IAppOption>({
  globalData: {
    userInfo: null,
    userType: 'normal',
    isAdmin: false,
    statusBarHeight: 20,
    topbarHeight: 64,
  },
  onLaunch() {
    const { statusBarHeight } = wx.getSystemInfoSync()
    const menuButton = wx.getMenuButtonBoundingClientRect()
    const sb = statusBarHeight || 20
    const topbarHeight = (menuButton.top - sb) * 2 + menuButton.height + sb
    this.globalData.statusBarHeight = sb
    this.globalData.topbarHeight = topbarHeight

    wx.cloud.init({
      env: 'dev021031-d3guj7zom3f13f9e8',
      traceUser: true,
    })

    // Try to restore session silently
    initAuth()
  },
})
