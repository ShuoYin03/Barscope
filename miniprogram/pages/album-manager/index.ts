interface Artist {
  _id: string
  artistId: number
  artistName: string
  picUrl: string
  albumSize: number
  approvedAlbumCount: number
  hiddenAlbumCount: number
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
let _titleSearchTimer: any = null

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    view: 'artists' as 'artists' | 'albums',
    searchMode: 'artist' as 'artist' | 'title',
    artistList: [] as Artist[],
    artistLoading: false,
    artistHasMore: false,
    artistPage: 1,
    artistPageSize: 30,
    artistKeyword: '',
    titleKeyword: '',
    titleResults: [] as Album[],
    titleLoading: false,
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
    if (page > 1) return
    this.setData({ artistLoading: true })
    wx.cloud.callFunction({
      name: 'getArtists',
      data: {
        keyword: this.data.artistKeyword,
        limit: 1000,
      },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ artistLoading: false }); return }
        this.setData({
          artistList: (r.list || []).map((item: any) => ({
            _id: item.id,
            artistId: Number(item.artistId || 0),
            artistName: item.artistName || '',
            picUrl: item.picUrl || '',
            albumSize: Number(item.albumSize || 0),
            approvedAlbumCount: Number(item.approvedAlbumCount || 0),
            hiddenAlbumCount: Number(item.hiddenAlbumCount || 0),
            fansSize: Number(item.fansSize || 0),
          })),
          artistPage: 1,
          artistHasMore: false,
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

  onSearchModeTap(e: WechatMiniprogram.TouchEvent) {
    const mode = (e.currentTarget.dataset as { mode: 'artist' | 'title' }).mode
    if (mode === this.data.searchMode) return
    this.setData({ searchMode: mode })
  },

  onTitleSearch(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value || ''
    this.setData({ titleKeyword: keyword })
    clearTimeout(_titleSearchTimer)
    _titleSearchTimer = setTimeout(() => this._searchByTitle(keyword), 400)
  },

  _searchByTitle(keyword: string) {
    const kw = keyword.trim()
    if (!kw) { this.setData({ titleResults: [], titleLoading: false }); return }
    this.setData({ titleLoading: true })
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'search_admin_albums', keyword: kw },
      success: (res: any) => {
        const r = res.result || {}
        this.setData({ titleResults: r.success ? (r.list || []) : [], titleLoading: false })
      },
      fail: () => this.setData({ titleLoading: false }),
    })
  },

  onReachBottom() {
    return
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

    const discographyCall = wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'list_admin_albums', artistId: artist.artistId, artistName: artist.artistName },
    }).catch(() => ({ result: { success: false, list: [] } }))

    const databaseCall = wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'search_admin_albums', keyword: artist.artistName },
    }).catch(() => ({ result: { success: false, list: [] } }))

    Promise.all([discographyCall, databaseCall]).then((responses: any[]) => {
      const discographyResult = responses[0]?.result || {}
      const databaseResult = responses[1]?.result || {}

      if (!discographyResult.success && !databaseResult.success) {
        this.setData({ albumLoading: false })
        return
      }

      const merged = [
        ...(discographyResult.success ? (discographyResult.list || []) : []),
        ...(databaseResult.success ? (databaseResult.list || []) : []),
      ] as Album[]

      const seen = new Set<string>()
      const list = merged
        .filter((album) => {
          if (!album || !album._id || seen.has(album._id)) return false
          seen.add(album._id)
          return true
        })
        .sort((a, b) => (b.releaseYear || 0) - (a.releaseYear || 0))

      this.setData({ albumList: list, albumLoading: false })
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
          const patch = (a: Album) => a._id === id ? { ...a, approved: newApproved } : a
          const albumList = this.data.albumList.map(patch)
          const titleResults = this.data.titleResults.map(patch)
          this.setData({ albumList, titleResults, toggling })
          wx.showToast({ title: newApproved ? '已显示' : '已隐藏', icon: 'success' })
          this._loadArtists(1)
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

  onUnload() { clearTimeout(_searchTimer); clearTimeout(_titleSearchTimer) },
})
