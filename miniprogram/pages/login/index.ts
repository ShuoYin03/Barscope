Page({
  data: {
    statusBarHeight: 20,
    nickName: '',
    avatarUrl: '',
    loading: false,
  },

  onLoad() {
    this.setData({ statusBarHeight: getApp<IAppOption>().globalData.statusBarHeight })
  },

  onChooseAvatar(e: any) {
    const { avatarUrl } = e.detail
    this.setData({ avatarUrl })
  },

  onNickInput(e: WechatMiniprogram.Input) {
    this.setData({ nickName: e.detail.value })
  },

  onLogin() {
    if (this.data.loading) return
    if (!this.data.avatarUrl) { wx.showToast({ title: '请先选择微信头像', icon: 'none' }); return }
    const nickName = this.data.nickName.trim()
    if (!nickName) { wx.showToast({ title: '请输入昵称', icon: 'none' }); return }

    this.setData({ loading: true })

    wx.login({
      success: () => this._uploadAvatarAndLogin(nickName),
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '获取登录凭证失败', icon: 'none' })
      },
    })
  },

  _uploadAvatarAndLogin(nickName: string) {
    const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
    wx.cloud.uploadFile({
      cloudPath,
      filePath: this.data.avatarUrl,
      success: (uploadRes) => this._callLogin(nickName, uploadRes.fileID),
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '头像上传失败，请重试', icon: 'none' })
      },
    })
  },

  _callLogin(nickName: string, avatarUrl: string) {
    wx.cloud.callFunction({
      name: 'login',
      data: { nickName, avatarUrl },
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
})
