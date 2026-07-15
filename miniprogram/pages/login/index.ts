import { getThemeClass } from '../../utils/theme'
import { markLoggedIn } from '../../utils/auth'

Page({
  data: {
    statusBarHeight: 20,
    capsuleTop: 26,
    capsuleHeight: 32,
    themeClass: '',
    nickName: '',
    avatarUrl: '',
    coverUrl: '',
    bio: '',
    loading: false,
    isUpdating: false,
  },

  _avatarFileId: '',
  _avatarUploadPromise: null as Promise<string> | null,
  _coverFileId: '',
  _coverUploadPromise: null as Promise<string> | null,

  onLoad() {
    const app = getApp<IAppOption>()
    const current = app.globalData.userInfo
    let capsuleTop = app.globalData.statusBarHeight + 6
    let capsuleHeight = 32

    try {
      const capsule = wx.getMenuButtonBoundingClientRect()
      if (capsule?.top && capsule?.height) {
        capsuleTop = capsule.top
        capsuleHeight = capsule.height
      }
    } catch (error) {
      console.warn('[personal-info] failed to read menu capsule', error)
    }

    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      capsuleTop,
      capsuleHeight,
      nickName: current?.nickName || '',
      avatarUrl: current?.avatarUrl || '',
      coverUrl: current?.coverUrl || '',
      bio: current?.bio || '',
      isUpdating: !!current,
    })
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  onBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/profile/index' })
  },

  onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    if (this.data.loading) return
    const avatarUrl = e.detail?.avatarUrl
    if (!avatarUrl) return

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

  onChooseCover() {
    if (this.data.loading) return
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const filePath = res.tempFilePaths && res.tempFilePaths[0]
        if (!filePath) return
        this.setData({ coverUrl: filePath })
        this._coverFileId = ''
        this._coverUploadPromise = this._uploadCover(filePath)
      },
    })
  },

  _uploadCover(filePath: string): Promise<string> {
    if (String(filePath || '').startsWith('cloud://')) return Promise.resolve(filePath)
    const cloudPath = `covers/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
    return wx.cloud.uploadFile({ cloudPath, filePath })
      .then((res) => { this._coverFileId = res.fileID; return res.fileID })
      .catch(() => '')
  },

  onNickInput(e: WechatMiniprogram.Input) {
    this.setData({ nickName: e.detail.value })
  },

  onBioInput(e: WechatMiniprogram.Input) {
    this.setData({ bio: e.detail.value })
  },

  onLogin() {
    if (this.data.loading) return
    if (!this.data.avatarUrl) { wx.showToast({ title: '请先授权头像', icon: 'none' }); return }
    const nickName = this.data.nickName.trim()
    if (!nickName) { wx.showToast({ title: '请输入昵称', icon: 'none' }); return }

    this.setData({ loading: true })

    wx.login({
      success: () => this._resolveMediaThenLogin(nickName),
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '获取登录凭证失败', icon: 'none' })
      },
    })
  },

  async _resolveMediaThenLogin(nickName: string) {
    let avatarFileId = this._avatarFileId || (this._avatarUploadPromise ? await this._avatarUploadPromise : '')
    if (!avatarFileId && String(this.data.avatarUrl).startsWith('cloud://')) avatarFileId = this.data.avatarUrl
    if (!avatarFileId) avatarFileId = await this._uploadAvatar(this.data.avatarUrl)

    if (!avatarFileId) {
      this.setData({ loading: false })
      wx.showToast({ title: '头像上传失败，请重试', icon: 'none' })
      return
    }

    let coverFileId = ''
    if (this.data.coverUrl) {
      coverFileId = this._coverFileId || (this._coverUploadPromise ? await this._coverUploadPromise : '')
      if (!coverFileId && String(this.data.coverUrl).startsWith('cloud://')) coverFileId = this.data.coverUrl
      if (!coverFileId) coverFileId = await this._uploadCover(this.data.coverUrl)
    }

    this._callLogin(nickName, avatarFileId, coverFileId)
  },

  _callLogin(nickName: string, avatarUrl: string, coverUrl: string) {
    wx.cloud.callFunction({
      name: 'login',
      data: { nickName, avatarUrl, coverUrl, bio: this.data.bio.trim() },
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
          coverUrl: user.coverUrl || '',
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
