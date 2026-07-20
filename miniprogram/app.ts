import { initAuth } from './utils/auth'
import { applyStoredTheme } from './utils/theme'
import { BEBAS_NEUE_B64 } from './assets/fonts/bebas-b64'

function installAlbumCorrectionEntryPatch() {
  const originalShowActionSheet = wx.showActionSheet.bind(wx)

  ;(wx as any).showActionSheet = (options: WechatMiniprogram.ShowActionSheetOption) => {
    const originalItems = Array.isArray(options.itemList) ? options.itemList.slice() : []
    const isAlbumCorrectionSheet =
      originalItems.includes('提交曲目纠错') &&
      originalItems.includes('修改专辑归属') &&
      originalItems.includes('类型纠错')

    if (!isAlbumCorrectionSheet) return originalShowActionSheet(options)

    const itemList = ['修改封面 / 信息']
    if (originalItems.includes('重新同步 Tracks')) itemList.push('重新同步 Tracks')
    if (originalItems.includes('移入专辑候选区')) itemList.push('移入专辑候选区')

    return originalShowActionSheet({
      ...options,
      itemList,
      success: (res) => {
        const picked = itemList[res.tapIndex]
        if (picked === '修改封面 / 信息') {
          const pages = getCurrentPages() as any[]
          const page = pages[pages.length - 1]
          const album = page && page.data && page.data.album
          if (!album || !album.id) {
            wx.showToast({ title: '未找到专辑信息', icon: 'none' })
            return
          }
          wx.navigateTo({
            url: `/pages/album-edit/index?albumId=${encodeURIComponent(album.id)}&title=${encodeURIComponent(album.title || '')}`,
          })
          return
        }

        const originalIndex = originalItems.indexOf(picked)
        if (originalIndex >= 0 && options.success) {
          options.success({ ...res, tapIndex: originalIndex })
        }
      },
    })
  }
}

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

    installAlbumCorrectionEntryPatch()

    // Bebas Neue bundled as base64 — no network needed, loads synchronously before first render.
    wx.loadFontFace({
      global: true,
      scopes: ['webview', 'native'],
      family: 'Bebas Neue',
      source: `url("data:font/truetype;base64,${BEBAS_NEUE_B64}")`,
      success: () => { console.log('[font] ✓ Bebas Neue loaded') },
      fail: (e: any) => { console.warn('[font] Bebas failed', e) },
    } as any)

    applyStoredTheme()
    initAuth()
  },
})