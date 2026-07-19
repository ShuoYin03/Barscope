interface Track {
  position: number
  neteaseSongId: string
  songName: string
  artistNames: string[]
  artistText?: string
}

interface Submission {
  _id: string
  creatorName: string
  neteasePlaylistId: string
  neteasePlaylistUrl: string
  playlistTitle: string
  playlistCoverUrl: string
  trackCount: number
  tracks: Track[]
  expanded?: boolean
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    creatorName: '',
    playlistUrl: '',
    importing: false,
    loading: false,
    list: [] as Submission[],
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
    })
    this._loadList()
  },

  onBack() { wx.navigateBack() },
  onCreatorInput(e: WechatMiniprogram.Input) { this.setData({ creatorName: e.detail.value || '' }) },
  onUrlInput(e: WechatMiniprogram.Input) { this.setData({ playlistUrl: e.detail.value || '' }) },

  _loadList() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'manageFeaturePlaylists',
      data: { action: 'list' },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) {
          wx.showToast({ title: '加载失败', icon: 'none' })
          this.setData({ loading: false })
          return
        }
        const list = (r.list || []).map((item: Submission) => ({
          ...item,
          expanded: false,
          tracks: (item.tracks || []).map(track => ({
            ...track,
            artistText: (track.artistNames || []).join(' / '),
          })),
        }))
        this.setData({ list, loading: false })
      },
      fail: () => this.setData({ loading: false }),
    })
  },

  onImport() {
    const creatorName = this.data.creatorName.trim()
    const playlistUrl = this.data.playlistUrl.trim()
    if (!creatorName) return wx.showToast({ title: '请填写博主名称', icon: 'none' })
    if (!playlistUrl) return wx.showToast({ title: '请粘贴网易云歌单链接', icon: 'none' })
    if (this.data.importing) return

    this.setData({ importing: true })
    wx.cloud.callFunction({
      name: 'manageFeaturePlaylists',
      data: { action: 'import', creatorName, playlistUrl },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) {
          const title = r.error === 'invalid_playlist_url' ? '歌单链接无效' : r.error === 'playlist_not_found' ? '未找到该歌单' : '抓取失败'
          wx.showToast({ title, icon: 'none' })
          return
        }
        wx.showToast({ title: r.updated ? '歌单已更新' : `已抓取 ${r.playlist?.trackCount || 0} 首`, icon: 'none' })
        this.setData({ creatorName: '', playlistUrl: '' })
        this._loadList()
      },
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
      complete: () => this.setData({ importing: false }),
    })
  },

  onToggle(e: WechatMiniprogram.TouchEvent) {
    const id = String((e.currentTarget.dataset as any).id || '')
    const list = this.data.list.map((item: Submission) => item._id === id ? { ...item, expanded: !item.expanded } : item)
    this.setData({ list })
  },

  onRemove(e: WechatMiniprogram.TouchEvent) {
    const id = String((e.currentTarget.dataset as any).id || '')
    const item = this.data.list.find((x: Submission) => x._id === id)
    if (!item) return
    wx.showModal({
      title: '移除歌单',
      content: `确认移除「${item.creatorName}」的投稿快照？`,
      confirmText: '移除',
      confirmColor: '#C94E25',
      success: res => {
        if (!res.confirm) return
        wx.cloud.callFunction({
          name: 'manageFeaturePlaylists',
          data: { action: 'remove', id },
          success: (r: any) => {
            if (r.result?.success) {
              this.setData({ list: this.data.list.filter((x: Submission) => x._id !== id) })
              wx.showToast({ title: '已移除', icon: 'none' })
            }
          },
        })
      },
    })
  },
})
