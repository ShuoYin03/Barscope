interface ProfileReview {
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
    isLoggedIn: false,
    userInfo: null as IAppOption['globalData']['userInfo'],
    isCritic: false,
    isAdmin: false,
    pendingCount: 0,
    reviews: [] as ProfileReview[],
    loading: false,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
    })
  },

  onShow() {
    if (typeof this.getTabBar === 'function') this.getTabBar().setData({ selected: 4 })
    const app = getApp<IAppOption>()
    const loggedIn = !!app.globalData.userInfo
    this.setData({
      isLoggedIn: loggedIn,
      userInfo: app.globalData.userInfo,
      isCritic: app.globalData.userType === 'critic',
    })
    if (loggedIn) this._loadReviews()
  },

  _loadReviews() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'getUserInfo',
      success: (res: any) => {
        const result = res.result
        if (!result.success) { this.setData({ loading: false }); return }

        // Update user info in case it changed (e.g. critic status)
        const app = getApp<IAppOption>()
        const user = result.user
        app.globalData.userInfo = {
          openId: user.openId,
          nickName: user.nickName,
          avatarUrl: user.avatarUrl || '',
          type: user.type,
          bio: user.bio || '',
          reviewCount: user.reviewCount || 0,
        }
        app.globalData.userType = user.type
        app.globalData.isAdmin  = user.type === 'admin'

        const isAdmin = user.type === 'admin'
        this.setData({
          userInfo: app.globalData.userInfo,
          isCritic: user.type === 'critic',
          isAdmin,
        })

        if (isAdmin) this._loadPendingCount()

        // Load user's reviews
        wx.cloud.callFunction({
          name: 'getReviews',
          data: { userId: user.openId, pageSize: 20 },
          success: (r: any) => {
            const rv = r.result
            const list = (rv.list || []).map((item: any) => ({
              _id: item._id,
              albumId: item.albumId,
              albumTitle: item.albumTitle || item.albumId,
              ratingText: '★'.repeat(item.rating || 0),
              content: item.content,
              timeAgo: item.timeAgo || '',
              likes: item.likes || 0,
            }))
            this.setData({ reviews: list, loading: false })
          },
          fail: () => this.setData({ loading: false }),
        })
      },
      fail: () => this.setData({ loading: false }),
    })
  },

  _loadPendingCount() {
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'stats' },
      success: (res: any) => {
        const r = res.result
        if (r.success) this.setData({ pendingCount: r.pending || 0 })
      },
    })
  },

  onAdminTap() {
    wx.navigateTo({ url: '/pages/admin/index' })
  },

  onLogin() {
    wx.navigateTo({ url: '/pages/login/index' })
  },

  onReviewTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id
    wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
  },
})
