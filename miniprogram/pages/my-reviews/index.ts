import { getThemeClass } from '../../utils/theme'

interface UserReview {
  _id: string
  albumId: string
  albumTitle: string
  ratingText: string
  content: string
  timeAgo: string
  likes: number
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    reviews: [] as UserReview[],
    loading: true,
    deletingId: ''
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight
    })
    this.loadReviews()
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  loadReviews() {
    const app = getApp<IAppOption>()
    const userId = app.globalData.userInfo?.openId
    if (!userId) {
      this.setData({ loading: false })
      return
    }

    wx.cloud.callFunction({
      name: 'getReviews',
      data: { userId, pageSize: 100 },
      success: (res: any) => {
        const result = res.result || {}
        const reviews = (result.list || []).map((item: any) => ({
          _id: item._id,
          albumId: item.albumId,
          albumTitle: item.albumTitle || item.albumId,
          ratingText: '★'.repeat(item.rating || 0),
          content: item.content || '',
          timeAgo: item.timeAgo || '',
          likes: item.likes || 0
        }))
        this.setData({ reviews, loading: false })
      },
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '评论加载失败', icon: 'none' })
      }
    })
  },

  onBack() {
    wx.navigateBack()
  },

  onReviewTap(e: WechatMiniprogram.TouchEvent) {
    const albumId = (e.currentTarget.dataset as { id: string }).id
    if (albumId) wx.navigateTo({ url: `/pages/album-detail/index?id=${albumId}` })
  },

  onDeleteTap(e: WechatMiniprogram.TouchEvent) {
    const reviewId = (e.currentTarget.dataset as { id: string }).id
    if (!reviewId || this.data.deletingId) return

    wx.showModal({
      title: '删除评论',
      content: '删除后无法恢复，确认删除这条评论吗？',
      confirmText: '删除',
      confirmColor: '#E5532D',
      success: modalRes => {
        if (!modalRes.confirm) return
        this.deleteReview(reviewId)
      }
    })
  },

  deleteReview(reviewId: string) {
    this.setData({ deletingId: reviewId })
    wx.cloud.callFunction({
      name: 'deleteReview',
      data: { reviewId },
      success: (res: any) => {
        const result = res.result || {}
        if (!result.success) {
          wx.showToast({ title: result.error || '删除失败', icon: 'none' })
          return
        }
        const reviews = (this.data.reviews as UserReview[]).filter(item => item._id !== reviewId)
        this.setData({ reviews })
        wx.showToast({ title: '已删除', icon: 'success' })
      },
      fail: () => wx.showToast({ title: '删除失败，请稍后重试', icon: 'none' }),
      complete: () => this.setData({ deletingId: '' })
    })
  }
})
