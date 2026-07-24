import { getThemeClass } from '../../utils/theme'
import { trackFeatureView, trackFeatureShare } from '../../utils/featureStats'

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

interface CopyField { key: string; label: string; value: string }

const COPY_DEFAULTS: Record<string, string> = {
  category: '榜单 · PLAYLIST POLL',
  title: '2026年上半年中文说唱单曲榜单',
  intro: '提交你的网易云歌单即可参与。乐评人歌单与社区投稿分别展示，并汇总所有有效歌单生成最终 Top50。',
  submitKicker: 'SUBMIT YOUR PLAYLIST',
  submitTitle: '只需要一个网易云歌单链接',
  endMark: '— 2026 H1 TOP 50 —',
}

const COPY_FIELD_LABELS: Record<string, string> = {
  category: '分类标签',
  title: '标题',
  intro: '简介',
  submitKicker: '提交区小标题（英文）',
  submitTitle: '提交区标题',
  endMark: '页尾文字',
}

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
    isAdmin: false,
    copy: { ...COPY_DEFAULTS },
    copyEditVisible: false,
    copyEditFields: [] as CopyField[],
    copySaving: false,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
    trackFeatureView(FEATURE_ID)
    this._loadPlaylists()
    this._loadCopy()
  },

  onShow() {
    const app = getApp<IAppOption>()
    this.setData({ themeClass: getThemeClass(), isAdmin: !!app.globalData.isAdmin })
  },

  _loadCopy() {
    wx.cloud.callFunction({
      name: 'manageFeaturePlaylists',
      data: { action: 'get_copy', pageKey: FEATURE_ID },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) return
        this.setData({ copy: { ...COPY_DEFAULTS, ...(r.fields || {}) } })
      },
    } as any)
  },

  onOpenCopyEditor() {
    const copy = this.data.copy
    const fields: CopyField[] = Object.keys(COPY_DEFAULTS).map(key => ({
      key,
      label: COPY_FIELD_LABELS[key] || key,
      value: (copy as any)[key] ?? COPY_DEFAULTS[key],
    }))
    this.setData({ copyEditVisible: true, copyEditFields: fields })
  },

  onCloseCopyEditor() {
    if (this.data.copySaving) return
    this.setData({ copyEditVisible: false })
  },

  onCopyFieldInput(e: WechatMiniprogram.Input) {
    const key = String((e.currentTarget.dataset as any).key || '')
    const value = e.detail.value || ''
    this.setData({
      copyEditFields: this.data.copyEditFields.map(f => (f.key === key ? { ...f, value } : f)),
    })
  },

  onSaveCopyEdit() {
    if (this.data.copySaving) return
    const fields: Record<string, string> = {}
    this.data.copyEditFields.forEach(f => { fields[f.key] = f.value })
    this.setData({ copySaving: true })
    wx.cloud.callFunction({
      name: 'manageFeaturePlaylists',
      data: { action: 'update_copy', pageKey: FEATURE_ID, fields },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) {
          wx.showToast({ title: r.error || '保存失败', icon: 'none' })
          return
        }
        this.setData({ copy: { ...COPY_DEFAULTS, ...(r.fields || {}) }, copyEditVisible: false })
        wx.showToast({ title: '已保存', icon: 'success' })
      },
      fail: () => wx.showToast({ title: '网络错误，请重试', icon: 'none' }),
      complete: () => this.setData({ copySaving: false }),
    } as any)
  },
  onBack() { wx.navigateBack() },
  noop() {},
  onUrlInput(e: WechatMiniprogram.Input) { this.setData({ playlistUrl: e.detail.value || '' }) },
  onToggleOwnPlaylist() { this.setData({ isOwnPlaylist: !this.data.isOwnPlaylist }) },

  onShareAppMessage() {
    trackFeatureShare(FEATURE_ID)
    return { title: '2026年上半年中文说唱单曲榜单', path: '/pages/h1-top50/index' }
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