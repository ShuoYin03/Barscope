import { initAuth } from './utils/auth'
import { BEBAS_NEUE_B64 } from './assets/fonts/bebas-b64'

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

    // Bebas Neue bundled as base64 — no network needed, loads synchronously before first render.
    wx.loadFontFace({
      global: true,
      scopes: ['webview', 'native'],
      family: 'Bebas Neue',
      source: `url("data:font/truetype;base64,${BEBAS_NEUE_B64}")`,
      success: () => { console.log('[font] ✓ Bebas Neue loaded') },
      fail: (e: any) => { console.warn('[font] Bebas failed', e) },
    } as any)

    initAuth()
  },
})
