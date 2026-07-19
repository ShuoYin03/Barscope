import { getThemeClass } from '../../utils/theme'

interface PlaylistCard {
  _id: string
  creatorName: string
  neteasePlaylistId: string
  neteasePlaylistUrl: string
  playlistTitle: string
  playlistCoverUrl: string
  trackCount: number
  sourceType?: 'editorial' | 'rapper' | 'community'
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
    activePlaylistTab: 'critics' as 'critics' | 'rappers' | 'community',
    criticList: [] as PlaylistCard[],
    rapperList: [] as PlaylistCard[],
    communityList: [] as PlaylistCard[],
    criticCount: 0,
    rapperCount: 0,
    communityCount: 0,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
    this._loadPlaylists()
  },

  onShow() { this.setData({ themeClass: getThemeClass() }) },
  onBack() { wx.navigateBack() },
  onUrlInput(e: WechatMiniprogram.Input) { this.setData({ playlistUrl: e.detail.value || '' }) },

  onPlaylistTabTap(e: WechatMiniprogram.TouchEvent) {
    const tab = String((e.currentTarget.dataset as any).tab || 'critics') as 'critics' | 'rappers' | 'community'
    this.setData({ activePlaylistTab: tab })
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
        const rapperList = list.filter(item => item.sourceType === 'rapper')
        const criticList = list.filter(item => item.isEditorial && item.sourceType !== 'rapper')
        const communityList = list.filter(item => !item.isEditorial && item.sourceType !== 'rapper')
        this.setData({
          criticList,
          rapperList,
          communityList,
          criticCount: criticList.length,
          rapperCount: rapperList.length,
          communityCount: communityList.length,
        })
      },
      complete: () => this.setData({ loading: false }),
    } as any)
  },

  onPlaylistTap(e: WechatMiniprogram.TouchEvent) {
    const id = String((e.currentTarget.dataset as any).id || '')
    if (!id) return
    wx.navigateTo({ url: `/pages/playlist-detail/index?id=${id}` })
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
          const message = r.error === 'invalid_playlist_url' ? '歌单链接无效' : r.error === 'playlist_not_found' ? '未找到该歌单' : '提交失败，请稍后重试'
          wx.showToast({ title: message, icon: 'none' })
          return
        }
        this.setData({ playlistUrl: '', activePlaylistTab: 'community' })
        wx.showToast({ title: r.duplicate ? '该歌单已收录' : '歌单已提交', icon: 'success' })
        this._loadPlaylists()
      },
      fail: () => wx.showToast({ title: '网络错误，请重试', icon: 'none' }),
      complete: () => { wx.hideLoading(); this.setData({ submitting: false }) },
    } as any)
  },
})