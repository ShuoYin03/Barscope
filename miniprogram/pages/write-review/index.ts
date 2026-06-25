Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    albumId: '',
    albumTitle: '',
    rating: 0,
    content: '',
    submitting: false,
  },

  onLoad(options) {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
      albumId: options.albumId || '',
      albumTitle: decodeURIComponent(options.albumTitle || ''),
    })
  },

  onBack() {
    wx.navigateBack()
  },

  onRateNum(e: WechatMiniprogram.TouchEvent) {
    const n = Number((e.currentTarget.dataset as { n: number }).n)
    this.setData({ rating: n })
  },

  onContentInput(e: WechatMiniprogram.Input) {
    this.setData({ content: e.detail.value })
  },

  onSubmit() {
    const { rating, content, submitting, albumId } = this.data
    if (submitting) return
    if (!rating) {
      wx.showToast({ title: '请先给出评分', icon: 'none' })
      return
    }
    if (!content.trim()) {
      wx.showToast({ title: '请输入评论内容', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '发布中...' })

    wx.cloud.callFunction({
      name: 'submitReview',
      data: { albumId, albumTitle: this.data.albumTitle, rating, content: content.trim() },
      success: (res: any) => {
        wx.hideLoading()
        const result = res.result
        if (result.success) {
          wx.showToast({ title: '评论已发布', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 1200)
        } else {
          this.setData({ submitting: false })
          wx.showToast({ title: result.error || '发布失败', icon: 'none' })
        }
      },
      fail: () => {
        wx.hideLoading()
        this.setData({ submitting: false })
        wx.showToast({ title: '网络错误，请重试', icon: 'none' })
      },
    })
  },
})
