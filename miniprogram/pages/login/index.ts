Page({
  data: {
    statusBarHeight: 20,
    nickName: '',
    loading: false,
  },

  onLoad() {
    this.setData({ statusBarHeight: getApp<IAppOption>().globalData.statusBarHeight })
  },

  onNickInput(e: WechatMiniprogram.Input) {
    this.setData({ nickName: e.detail.value })
  },

  onLogin() {
    if (this.data.loading) return
    this.setData({ loading: true })

    wx.login({
      success: () => {
        wx.cloud.callFunction({
          name: 'login',
          data: { nickName: this.data.nickName.trim() || '说唱迷' },
          success: (res: any) => {
            const result = res.result
            if (!result.success) {
              this.setData({ loading: false })
              wx.showToast({ title: result.error || '登录失败', icon: 'none' })
              return
            }
            const user = result.user
            const app = getApp<IAppOption>()
            app.globalData.userInfo = {
              openId: user.openId,
              nickName: user.nickName,
              avatarUrl: user.avatarUrl || '',
              type: user.type,
              bio: user.bio || '',
              reviewCount: user.reviewCount || 0,
            }
            app.globalData.userType = user.type
            this.setData({ loading: false })
            wx.showToast({ title: '登录成功', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 1000)
          },
          fail: () => {
            this.setData({ loading: false })
            wx.showToast({ title: '登录失败，请重试', icon: 'none' })
          },
        })
      },
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '获取登录凭证失败', icon: 'none' })
      },
    })
  },
})
