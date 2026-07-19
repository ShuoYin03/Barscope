import { getThemeClass } from '../../utils/theme'

interface PlaylistTrack {
  position: number
  neteaseSongId: string
  songName: string
  artistNames: string[]
  albumId: string
  albumName: string
  coverUrl: string
  barscopeAlbumId?: string
  albumCatalogStatus?: 'linked' | 'pending'
  missingArtistNames?: string[]
  artistText?: string
}

interface PlaylistCard {
  _id: string
  creatorName: string
  neteasePlaylistId: string
  neteasePlaylistUrl: string
  playlistTitle: string
  playlistCoverUrl: string
  trackCount: number
  isEditorial: boolean
  expanded?: boolean
  detailLoading?: boolean
  tracks?: PlaylistTrack[]
  catalogSync?: {
    linkedAlbums: number
    pendingAlbums: number
    pendingArtists: number
  }
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
        const list = ((r.list || []) as PlaylistCard[]).map(item => ({ ...item, expanded: false, detailLoading: false }))
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

  _findPlaylist(id: string) {
    const editorial = this.data.editorialList.find(item => item._id === id)
    if (editorial) return { listKey: 'editorialList', item: editorial }
    const community = this.data.communityList.find(item => item._id === id)
    if (community) return { listKey: 'communityList', item: community }
    return null
  },

  _patchPlaylist(listKey: 'editorialList' | 'communityList', id: string, patch: Partial<PlaylistCard>) {
    const list = this.data[listKey].map(item => item._id === id ? { ...item, ...patch } : item)
    this.setData({ [listKey]: list } as any)
  },

  onPlaylistTap(e: WechatMiniprogram.TouchEvent) {
    const id = String((e.currentTarget.dataset as any).id || '')
    if (!id) return
    const found = this._findPlaylist(id)
    if (!found) return

    if (found.item.expanded) {
      this._patchPlaylist(found.listKey as any, id, { expanded: false })
      return
    }

    if (found.item.tracks && found.item.tracks.length) {
      this._patchPlaylist(found.listKey as any, id, { expanded: true })
      return
    }

    this._patchPlaylist(found.listKey as any, id, { detailLoading: true, expanded: true })
    wx.cloud.callFunction({
      name: 'manageFeaturePlaylists',
      data: { action: 'get_public_detail', id },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success || !r.playlist) {
          wx.showToast({ title: '歌单加载失败', icon: 'none' })
          this._patchPlaylist(found.listKey as any, id, { expanded: false })
          return
        }
        const tracks = (r.playlist.tracks || []).map((track: PlaylistTrack) => ({
          ...track,
          artistText: (track.artistNames || []).join(' / '),
        }))
        this._patchPlaylist(found.listKey as any, id, {
          tracks,
          catalogSync: r.playlist.catalogSync,
          detailLoading: false,
          expanded: true,
        })
      },
      fail: () => {
        wx.showToast({ title: '歌单加载失败', icon: 'none' })
        this._patchPlaylist(found.listKey as any, id, { detailLoading: false, expanded: false })
      },
      complete: () => this._patchPlaylist(found.listKey as any, id, { detailLoading: false }),
    } as any)
  },

  onTrackTap(e: WechatMiniprogram.TouchEvent) {
    const albumId = String((e.currentTarget.dataset as any).albumId || '')
    const status = String((e.currentTarget.dataset as any).status || '')
    if (albumId) {
      wx.navigateTo({ url: `/pages/album-detail/index?id=${albumId}` })
      return
    }
    wx.showToast({
      title: status === 'pending' ? '该专辑已进入后台审核' : '该专辑暂未收录',
      icon: 'none',
    })
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
