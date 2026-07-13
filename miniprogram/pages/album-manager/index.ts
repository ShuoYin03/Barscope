interface Artist {
  _id: string
  artistId: number
  artistName: string
  picUrl: string
  albumSize: number
  fansSize: number
}

interface Album {
  _id: string
  title: string
  artist: string
  primaryArtist: string
  releaseYear: number
  coverUrl: string
  approved: boolean
  avgScore: number
  reviewCount: number
  trackCount: number
}

interface DuplicateSample {
  key: string
  keep: { _id: string; title: string; artist: string; approved: boolean; reviewCount: number }
  remove: Array<{ _id: string; title: string; artist: string; approved: boolean; reviewCount: number }>
}

interface CleanupPreview {
  scanned: number
  duplicateGroups: number
  wouldRemove: number
  samples: DuplicateSample[]
}

import { getThemeClass } from '../../utils/theme'

let _searchTimer: any = null

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    view: 'artists' as 'artists' | 'albums',
    artistList: [] as Artist[],
    artistLoading: false,
    artistHasMore: false,
    artistPage: 1,
    artistPageSize: 30,
    artistKeyword: '',
    cleanupLoading: false,
    cleanupPreview: null as CleanupPreview | null,
    cleanupResult: null as any,
    selectedArtist: null as Artist | null,
    albumList: [] as Album[],
    albumLoading: false,
    toggling: {} as Record<string, boolean>,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
    })
    this._loadArtists(1)
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  onBack() {
    if (this.data.view === 'albums') this.setData({ view: 'artists', selectedArtist: null, albumList: [] })
    else wx.navigateBack()
  },

  _loadArtists(page: number) {
    this.setData({ artistLoading: true })
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: {
        action: 'list',
        status: 'approved',
        page,
        pageSize: this.data.artistPageSize,
        keyword: this.data.artistKeyword,
      },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ artistLoading: false }); return }
        const newList = page === 1 ? r.list : [...this.data.artistList, ...r.list]
        this.setData({
          artistList: newList,
          artistPage: page,
          artistHasMore: r.list.length === this.data.artistPageSize,
          artistLoading: false,
        })
      },
      fail: () => this.setData({ artistLoading: false }),
    })
  },

  onArtistSearch(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value || ''
    this.setData({ artistKeyword: keyword, artistList: [], artistPage: 1 })
    clearTimeout(_searchTimer)
    _searchTimer = setTimeout(() => this._loadArtists(1), 400)
  },

  onReachBottom() {
    if (this.data.view !== 'artists' || !this.data.artistHasMore || this.data.artistLoading) return
    this._loadArtists(this.data.artistPage + 1)
  },

  onPullDownRefresh() {
    if (this.data.view === 'artists') {
      this._loadArtists(1)
      this.setData({ cleanupPreview: null, cleanupResult: null })
    } else if (this.data.selectedArtist) {
      this._loadAlbums(this.data.selectedArtist)
    }
    wx.stopPullDownRefresh()
  },

  onArtistTap(e: WechatMiniprogram.TouchEvent) {
    const artist = (e.currentTarget.dataset as { artist: Artist }).artist
    this.setData({ view: 'albums', selectedArtist: artist, albumList: [] })
    this._loadAlbums(artist)
  },

  onPreviewDuplicates() {
    if (this.data.cleanupLoading) return
    this.setData({ cleanupLoading: true, cleanupResult: null })
    wx.cloud.callFunction({
      name: 'cleanupDuplicates',
      data: { dryRun: true },
      success: (res: any) => {
        const r = res.result || {}
        this.setData({ cleanupLoading: false })
        if (!r.success) { wx.showToast({ title: '扫描失败', icon: 'error' }); return }
        this.setData({ cleanupPreview: {
          scanned: r.scanned || 0,
          duplicateGroups: r.duplicateGroups || 0,
          wouldRemove: r.wouldRemove || 0,
          samples: r.samples || [],
        } })
        wx.showToast({ title: r.wouldRemove ? '发现重复' : '暂无重复', icon: 'none' })
      },
      fail: () => { this.setData({ cleanupLoading: false }); wx.showToast({ title: '网络错误', icon: 'error' }) },
    })
  },

  onRunDuplicateCleanup() {
    const preview = this.data.cleanupPreview
    if (!preview || !preview.wouldRemove || this.data.cleanupLoading) return
    wx.showModal({
      title: '确认清理重复专辑？',
      content: `将删除 ${preview.wouldRemove} 张重复专辑，并把评论/收藏迁移到保留专辑。该操作不可撤销。`,
      confirmText: '确认清理',
      confirmColor: '#dc2626',
      success: (modalRes) => {
        if (!modalRes.confirm) return
        this.setData({ cleanupLoading: true })
        wx.cloud.callFunction({
          name: 'cleanupDuplicates',
          data: { dryRun: false },
          success: (res: any) => {
            const r = res.result || {}
            this.setData({ cleanupLoading: false })
            if (!r.success) { wx.showToast({ title: '清理失败', icon: 'error' }); return }
            this.setData({ cleanupResult: r, cleanupPreview: null })
            wx.showToast({ title: `已删除 ${r.removed || 0} 张`, icon: 'success' })
            this._loadArtists(1)
          },
          fail: () => { this.setData({ cleanupLoading: false }); wx.showToast({ title: '网络错误', icon: 'error' }) },
        })
      },
    })
  },

  _loadAlbums(artist: Artist) {
    this.setData({ albumLoading: true })
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'list_admin_albums', artistId: artist.artistId, artistName: artist.artistName },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ albumLoading: false }); return }
        this.setData({ albumList: r.list || [], albumLoading: false })
      },
      fail: () => this.setData({ albumLoading: false }),
    })
  },

  onToggleApproved(e: WechatMiniprogram.TouchEvent) {
    const { id, approved } = e.currentTarget.dataset as { id: string; approved: boolean }
    if (this.data.toggling[id]) return
    const newApproved = !approved
    this.setData({ toggling: { ...this.data.toggling, [id]: true } })

    wx.cloud.callFunction({
      name: 'manageAlbumCandidates',
      data: { action: 'setHiddenState', albumId: id, approved: newApproved },
      success: (res: any) => {
        const toggling = { ...this.data.toggling }
        delete toggling[id]
        if (res.result?.success) {
          const albumList = this.data.albumList.map((a: Album) => a._id === id ? { ...a, approved: newApproved } : a)
          this.setData({ albumList, toggling })
          wx.showToast({ title: newApproved ? '已显示' : '已隐藏', icon: 'success' })
        } else {
          this.setData({ toggling })
          wx.showToast({ title: res.result?.error || '操作失败', icon: 'none' })
        }
      },
      fail: () => {
        const toggling = { ...this.data.toggling }
        delete toggling[id]
        this.setData({ toggling })
        wx.showToast({ title: '网络错误', icon: 'error' })
      },
    })
  },

  onUnload() { clearTimeout(_searchTimer) },
})
