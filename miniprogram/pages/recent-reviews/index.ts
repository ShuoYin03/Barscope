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
  },

  onBack() {
    wx.navigateBack()
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
    this.setData({ page: 1, hasMore: true })
    this.loadReviews(1)
    wx.stopPullDownRefresh()
  },
})