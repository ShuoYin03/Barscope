import { getThemeClass } from '../../utils/theme'
import { markLoggedIn } from '../../utils/auth'

Page({
  data: {
    statusBarHeight: 20,
    themeClass: '',
    nickName: '',
    avatarUrl: '',
    loading: false,
    isUpdating: false,
  },

  _avatarFileId: '',
  _avatarUploadPromise: null as Promise<string> | null,

  onLoad() {
    const app = getApp<IAppOption>()
    const current = app.globalData.userInfo
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      nickName: current?.nickName || '',
      avatarUrl: current?.avatarUrl || '',
      isUpdating: !!current,
    })
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  onChooseAvatar(e: any) {
    const { avatarUrl } = e.detail
    this.setData({ avatarUrl })
    this._avatarFileId = ''
    this._avatarUploadPromise = this._uploadAvatar(avatarUrl)
  },

  _uploadAvatar(filePath: string): Promise<string> {
    if (String(filePath || '').startsWith('cloud://')) return Promise.resolve(filePath)
    const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
    return wx.cloud.uploadFile({ cloudPath, filePath })
      .then((res) => { this._avatarFileId = res.fileID; return res.fileID })
      .catch(() => '')
  },

  onNickInput(e: WechatMiniprogram.Input) {
    this.setData({ nickName: e.detail.value })
  },

  onLogin() {
    if (this.data.loading) return
    if (!this.data.avatarUrl) { wx.showToast({ title: '请先选择微信头像', icon: 'none' }); return }
    const nickName = this.data.nickName.trim()
    if (!nickName) { wx.showToast({ title: '请输入微信昵称', icon: 'none' }); return }

    this.setData({ loading: true })

    wx.login({
      success: () => this._resolveAvatarThenLogin(nickName),
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '获取登录凭证失败', icon: 'none' })
      },
    })
  },

  async _resolveAvatarThenLogin(nickName: string) {
    let fileId = this._avatarFileId || (this._avatarUploadPromise ? await this._avatarUploadPromise : '')
    if (!fileId && String(this.data.avatarUrl).startsWith('cloud://')) fileId = this.data.avatarUrl
    if (!fileId) fileId = await this._uploadAvatar(this.data.avatarUrl)

    if (!fileId) {
      this.setData({ loading: false })
      wx.showToast({ title: '头像上传失败，请重试', icon: 'none' })
      return
    }
    this._callLogin(nickName, fileId)
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
        app.globalData.isAdmin = user.type === 'admin'
        markLoggedIn()
        this.setData({ loading: false })
        wx.showToast({ title: this.data.isUpdating ? '资料已更新' : '登录成功', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 800)
      },
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '登录失败，请重试', icon: 'none' })
      },
    })
  },
})
