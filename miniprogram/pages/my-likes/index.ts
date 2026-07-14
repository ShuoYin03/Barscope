import { getThemeClass } from '../../utils/theme'

interface LikedReview {
  _id: string
  albumId: string
  albumTitle: string
  userName: string
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
    reviews: [] as LikedReview[],
    loading: true,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
    })
    this.loadLikes()
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  loadLikes() {
    const app = getApp<IAppOption>()
    const userId = app.globalData.userInfo?.openId
    if (!userId) {
      this.setData({ loading: false })
      return
    }

    wx.cloud.callFunction({
      name: 'getReviews',
      data: { likedBy: userId, pageSize: 100 },
      success: (res: any) => {
        const result = res.result || {}
        const reviews = (result.list || []).map((item: any) => ({
          _id: item._id,
          albumId: item.albumId,
          albumTitle: item.albumTitle || item.albumId,
          userName: item.userName || '匿名用户',
          ratingText: '★'.repeat(item.rating || 0),
          content: item.content || '',
          timeAgo: item.timeAgo || '',
          likes: item.likes || 0,
        }))
        this.setData({ reviews, loading: false })
      },
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '加载失败', icon: 'none' })
      },
    } as any)
  },

  onBack() {
    wx.navigateBack()
  },

  onReviewTap(e: WechatMiniprogram.TouchEvent) {
    const albumId = (e.currentTarget.dataset as { id: string }).id
    if (albumId) wx.navigateTo({ url: `/pages/album-detail/index?id=${albumId}` })
  },
})
