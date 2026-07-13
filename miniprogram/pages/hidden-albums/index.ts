import { getThemeClass } from '../../utils/theme'

interface HiddenAlbum {
  _id: string
  title: string
  artist: string
  primaryArtist: string
  releaseYear: number
  coverUrl: string
  trackCount: number
  reviewCount: number
  approved: boolean
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    list: [] as HiddenAlbum[],
    loading: false,
    page: 1,
    pageSize: 50,
    total: 0,
    hasMore: false,
    toggling: {} as Record<string, boolean>,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
    })
    this.loadHiddenAlbums(1)
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  onBack() {
    wx.navigateBack()
  },

  loadHiddenAlbums(page: number) {
    if (this.data.loading) return
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'getHiddenAlbums',
      data: { page, pageSize: this.data.pageSize },
      success: (res: any) => {
        const result = res.result || {}
        if (!result.success) {
          wx.showToast({ title: result.error || '加载失败', icon: 'none' })
          return
        }
        const rows = result.list || []
        this.setData({
          list: page === 1 ? rows : [...this.data.list, ...rows],
          page,
          total: result.total || 0,
          hasMore: !!result.hasMore,
        })
      },
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
      complete: () => this.setData({ loading: false }),
    })
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadHiddenAlbums(this.data.page + 1)
  },

  onPullDownRefresh() {
    this.setData({ list: [], page: 1 })
    this.loadHiddenAlbums(1)
    wx.stopPullDownRefresh()
  },

  onShowAlbum(e: WechatMiniprogram.TouchEvent) {
    const id = String((e.currentTarget.dataset as any).id || '')
    if (!id || this.data.toggling[id]) return
    this.setData({ toggling: { ...this.data.toggling, [id]: true } })
    wx.cloud.callFunction({
      name: 'manageAlbumCandidates',
      data: { action: 'setHiddenState', albumId: id, approved: true },
      success: (res: any) => {
        if (!res.result?.success) {
          wx.showToast({ title: res.result?.error || '操作失败', icon: 'none' })
          return
        }
        this.setData({
          list: this.data.list.filter((item: HiddenAlbum) => item._id !== id),
          total: Math.max(0, this.data.total - 1),
        })
        wx.showToast({ title: '已恢复显示', icon: 'success' })
      },
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
      complete: () => {
        const toggling = { ...this.data.toggling }
        delete toggling[id]
        this.setData({ toggling })
      },
    })
  },
})
