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
  artistText?: string
}

Page({
  data: {
    statusBarHeight: 20,
    themeClass: '',
    loading: true,
    playlist: null as any,
    tracks: [] as PlaylistTrack[],
    sync: null as any,
  },

  onLoad(options: any) {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight })
    const id = String(options.id || '')
    if (!id) {
      wx.showToast({ title: '歌单不存在', icon: 'none' })
      return
    }
    this._load(id)
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  onBack() {
    wx.navigateBack()
  },

  _load(id: string) {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'manageFeaturePlaylists',
      data: { action: 'get_public_detail', id },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success || !r.playlist) {
          wx.showToast({ title: '歌单加载失败', icon: 'none' })
          return
        }
        const playlist = r.playlist
        const tracks = (playlist.tracks || []).map((track: PlaylistTrack) => ({
          ...track,
          artistText: (track.artistNames || []).join(' / '),
        }))
        this.setData({ playlist, tracks, sync: playlist.catalogSync || null })
      },
      fail: () => wx.showToast({ title: '歌单加载失败', icon: 'none' }),
      complete: () => this.setData({ loading: false }),
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
})
