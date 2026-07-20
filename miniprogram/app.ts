import { initAuth } from './utils/auth'
import { applyStoredTheme } from './utils/theme'
import { BEBAS_NEUE_B64 } from './assets/fonts/bebas-b64'

function installAlbumCoverCorrectionPatch() {
  const originalShowActionSheet = wx.showActionSheet.bind(wx)

  ;(wx as any).showActionSheet = (options: WechatMiniprogram.ShowActionSheetOption) => {
    const originalItems = Array.isArray(options.itemList) ? options.itemList.slice() : []
    const isAlbumCorrectionSheet =
      originalItems.includes('提交曲目纠错') &&
      originalItems.includes('修改专辑归属') &&
      originalItems.includes('类型纠错')

    if (!isAlbumCorrectionSheet || originalItems.includes('修改封面')) {
      return originalShowActionSheet(options)
    }

    const insertAt = originalItems.indexOf('类型纠错') + 1
    const itemList = originalItems.slice()
    itemList.splice(insertAt, 0, '修改封面')

    return originalShowActionSheet({
      ...options,
      itemList,
      success: (res) => {
        const picked = itemList[res.tapIndex]
        if (picked === '修改封面') {
          const pages = getCurrentPages() as any[]
          const page = pages[pages.length - 1]
          const album = page && page.data && page.data.album
          if (!album || !album.id) {
            wx.showToast({ title: '未找到专辑信息', icon: 'none' })
            return
          }

          wx.chooseMedia({
            count: 1,
            mediaType: ['image'],
            sourceType: ['album', 'camera'],
            success: (chooseRes: any) => {
              const filePath = chooseRes.tempFiles && chooseRes.tempFiles[0] && chooseRes.tempFiles[0].tempFilePath
              if (!filePath) return

              wx.showLoading({ title: '上传封面…', mask: true })
              const ext = (filePath.split('.').pop() || 'jpg').toLowerCase()
              const cloudPath = `album-covers/manual/${album.id}_${Date.now()}.${ext}`

              wx.cloud.uploadFile({
                cloudPath,
                filePath,
                success: (uploadRes: any) => {
                  wx.cloud.callFunction({
                    name: 'updateAlbumCover',
                    data: { albumId: album.id, coverUrl: uploadRes.fileID },
                    success: (callRes: any) => {
                      wx.hideLoading()
                      const result = callRes.result || {}
                      if (!result.success) {
                        wx.showToast({ title: result.error || '修改失败', icon: 'none' })
                        return
                      }
                      if (page && typeof page.setData === 'function') {
                        page.setData({ 'album.coverUrl': uploadRes.fileID })
                      }
                      wx.showToast({ title: '封面已更新', icon: 'success' })
                    },
                    fail: () => {
                      wx.hideLoading()
                      wx.showToast({ title: '修改失败', icon: 'none' })
                    },
                  } as any)
                },
                fail: () => {
                  wx.hideLoading()
                  wx.showToast({ title: '封面上传失败', icon: 'none' })
                },
              })
            },
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

    installAlbumCoverCorrectionPatch()

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
