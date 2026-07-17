import { getThemeClass } from '../../utils/theme'

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    reviews: [] as any[],
    page: 1,
    pageSize: 20,
    loading: false,
    hasMore: true,
    hasLoadedOnce: false,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
    })
    this.loadReviews(1)
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })

    // Returning from an album/review detail page must re-fetch the first page so
    // live interaction metadata (likes / replies) is not left at the snapshot
    // that was rendered before navigation.
    if (this.data.hasLoadedOnce && !this.data.loading) {
      this.refreshReviews()
    }
  },

  onBack() {
    wx.navigateBack()
  },

  refreshReviews(done?: () => void) {
    if (this.data.loading) {
      if (done) done()
      return
    }
    this.setData({ loading: true, page: 1, hasMore: true })
    wx.cloud.callFunction({
      name: 'getReviews',
      data: { recent: true, page: 1, pageSize: this.data.pageSize },
      success: (res: any) => {
        const result = res.result || {}
        const incoming = result.success ? (result.list || []) : []
        this.setData({
          reviews: incoming,
          page: 1,
          hasMore: incoming.length === this.data.pageSize,
          loading: false,
          hasLoadedOnce: true,
        })
      },
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '评论刷新失败', icon: 'none' })
      },
      complete: () => {
        if (done) done()
      },
    })
  },

  loadReviews(page: number) {
    if (this.data.loading || (page > 1 && !this.data.hasMore)) return
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'getReviews',
      data: { recent: true, page, pageSize: this.data.pageSize },
      success: (res: any) => {
        const result = res.result || {}
        const incoming = result.success ? (result.list || []) : []
        const reviews = page === 1 ? incoming : [...this.data.reviews, ...incoming]
        this.setData({
          reviews,
          page,
          hasMore: incoming.length === this.data.pageSize,
          loading: false,
          hasLoadedOnce: true,
        })
      },
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '评论加载失败', icon: 'none' })
      },
    })
  },

  onReachBottom() {
    this.loadReviews(this.data.page + 1)
  },

  onReviewTap(e: WechatMiniprogram.TouchEvent) {
    const albumId = String((e.currentTarget.dataset as any).id || '')
    if (albumId) wx.navigateTo({ url: `/pages/album-detail/index?id=${albumId}` })
  },

  onPullDownRefresh() {
    this.refreshReviews(() => wx.stopPullDownRefresh())
  },
})