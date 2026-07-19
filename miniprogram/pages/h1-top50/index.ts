import { getThemeClass } from '../../utils/theme'

interface PlaylistCard {
  _id: string
  creatorName: string
  neteasePlaylistId: string
  neteasePlaylistUrl: string
  playlistTitle: string
  playlistCoverUrl: string
  trackCount: number
  isEditorial: boolean
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    playlistUrl: '',
    submitting: false,
    loading: false,
    editorialList: [] as PlaylistCard[],
    communityList: [] as PlaylistCard[],
    editorialCount: 0,
    communityCount: 0,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
    })
    this._loadPlaylists()
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  onBack() {
    wx.navigateBack()
  },

  onUrlInput(e: WechatMiniprogram.Input) {
    this.setData({ playlistUrl: e.detail.value || '' })
  },

  _loadPlaylists() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'manageFeaturePlaylists',
      data: { action: 'list_public' },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) return
        const list = (r.list || []) as PlaylistCard[]
        this.setData({
          editorialList: list.filter(item => item.isEditorial),
          communityList: list.filter(item => !item.isEditorial),
          editorialCount: r.editorialCount || 0,
          communityCount: r.communityCount || 0,
        })
      },
      complete: () => this.setData({ loading: false }),
    } as any)
  },

  onSubmitPlaylist() {
    const playlistUrl = this.data.playlistUrl.trim()
    if (!playlistUrl) {
      wx.showToast({ title: '请粘贴网易云歌单链接', icon: 'none' })
      return
    }
    if (this.data.submitting) return

    this.setData({ submitting: true })
    wx.showLoading({ title: '正在读取歌单…', mask: true })
    wx.cloud.callFunction({
      name: 'manageFeaturePlaylists',
      data: { action: 'submit_public', playlistUrl },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) {
          const message = r.error === 'invalid_playlist_url'
            ? '歌单链接无效'
            : r.error === 'playlist_not_found'
              ? '未找到该歌单'
              : '提交失败，请稍后重试'
          wx.showToast({ title: message, icon: 'none' })
          return
        }
        this.setData({ playlistUrl: '' })
        wx.showToast({ title: r.duplicate ? '该歌单已收录' : '歌单已提交', icon: 'success' })
        this._loadPlaylists()
      },
      fail: () => wx.showToast({ title: '网络错误，请重试', icon: 'none' }),
      complete: () => {
        wx.hideLoading()
        this.setData({ submitting: false })
      },
    } as any)
  },
})
