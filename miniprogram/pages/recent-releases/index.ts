Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,
    list:            [] as any[],
    loading:         true,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
    this._loadList()
  },

  _loadList() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'getLatestAlbums',
      data: { limit: 30 },
      success: (res: any) => {
        const result = res.result
        const list = result && result.success
          ? (result.list || []).map((a: any, i: number) => ({
              ...a,
              rankDisplay: String(i + 1).padStart(2, '0'),
            }))
          : []
        this.setData({ list, loading: false })
      },
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '加载失败', icon: 'none' })
      },
    } as any)
  },

  onAlbumTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as any).id
    if (id) wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
  },

  onBack() { wx.navigateBack() },
})
