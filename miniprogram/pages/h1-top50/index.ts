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

const FEATURE_ID = '2026-h1-top-50-tracks'

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    playlistUrl: '',
    submitting: false,
    loading: false,
    activePlaylistTab: 'critics' as 'critics' | 'community',
    criticList: [] as PlaylistCard[],
    communityList: [] as PlaylistCard[],
    criticCount: 0,
    communityCount: 0,
    isOwnPlaylist: false,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
    this._trackView()
    this._loadPlaylists()
  },

  onShow() { this.setData({ themeClass: getThemeClass() }) },
  onBack() { wx.navigateBack() },
  onUrlInput(e: WechatMiniprogram.Input) { this.setData({ playlistUrl: e.detail.value || '' }) },
  onToggleOwnPlaylist() { this.setData({ isOwnPlaylist: !this.data.isOwnPlaylist }) },

  _trackView() {
    wx.cloud.callFunction({
      name: 'manageFeatureStats',
      data: { action: 'track_view', featureId: FEATURE_ID },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) console.error('[h1-top50] track view failed', r)
      },
      fail: (err: any) => console.error('[h1-top50] track view call failed', err),
    } as any)
  },

  onShareAppMessage() {
    wx.cloud.callFunction({ name: 'manageFeatureStats', data: { action: 'track_share', featureId: FEATURE_ID } } as any)
    return { title: '2026 上半年中文说唱 Top50 单曲', path: '/pages/h1-top50/index' }
  },

  onPlaylistTabTap(e: WechatMiniprogram.TouchEvent) {
    const tab = String((e.currentTarget.dataset as any).tab || 'critics') as 'critics' | 'community'
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
        const criticList = list.filter(item => item.isEditorial)
        const communityList = list.filter(item => !item.isEditorial)
        this.setData({
          criticList,
          communityList,
          criticCount: criticList.length,
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
      data: { action: 'submit_public', playlistUrl, isOwnPlaylist: this.data.isOwnPlaylist },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) {
          const message = r.error === 'invalid_playlist_url' ? '歌单链接无效' : r.error === 'playlist_not_found' ? '未找到该歌单' : '提交失败，请稍后重试'
          wx.showToast({ title: message, icon: 'none' })
          return
        }
        this.setData({ playlistUrl: '', isOwnPlaylist: false, activePlaylistTab: 'community' })
        wx.showToast({ title: r.duplicate ? '已重新排查一遍缺失的艺人/专辑' : '歌单已提交', icon: 'success', duration: 2200 })
        this._loadPlaylists()
      },
      fail: () => wx.showToast({ title: '网络错误，请重试', icon: 'none' }),
      complete: () => { wx.hideLoading(); this.setData({ submitting: false }) },
    } as any)
  },
})