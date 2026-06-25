interface Artist {
  _id:        string
  artistId:   number
  artistName: string
  picUrl:     string
  albumSize:  number
  fansSize:   number
}

interface Album {
  _id:          string
  title:        string
  artist:       string
  primaryArtist: string
  releaseYear:  number
  coverUrl:     string
  approved:     boolean
  avgScore:     number
  reviewCount:  number
  trackCount:   number
}

const formatFans = (n: number): string => {
  if (!n) return ''
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万粉`
  return `${n} 粉`
}

let _searchTimer: any = null

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,

    // artist list view
    view:          'artists' as 'artists' | 'albums',
    artistList:    [] as Artist[],
    artistLoading: false,
    artistHasMore: false,
    artistPage:    1,
    artistPageSize: 30,
    artistKeyword: '',

    // album detail view
    selectedArtist:  null as Artist | null,
    albumList:       [] as Album[],
    albumLoading:    false,
    toggling:        {} as Record<string, boolean>,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight:    app.globalData.topbarHeight,
    })
    this._loadArtists(1)
  },

  onBack() {
    if (this.data.view === 'albums') {
      this.setData({ view: 'artists', selectedArtist: null, albumList: [] })
    } else {
      wx.navigateBack()
    }
  },

  // ── Artist list ──────────────────────────────────────────────────────────────
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
        const r = res.result
        if (!r.success) { this.setData({ artistLoading: false }); return }
        const newList = page === 1 ? r.list : [...this.data.artistList, ...r.list]
        this.setData({
          artistList:    newList,
          artistPage:    page,
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
    if (this.data.view === 'artists') {
      if (!this.data.artistHasMore || this.data.artistLoading) return
      this._loadArtists(this.data.artistPage + 1)
    }
  },

  onPullDownRefresh() {
    if (this.data.view === 'artists') {
      this._loadArtists(1)
    } else {
      this._loadAlbums(this.data.selectedArtist!)
    }
    wx.stopPullDownRefresh()
  },

  onArtistTap(e: WechatMiniprogram.TouchEvent) {
    const artist = (e.currentTarget.dataset as { artist: Artist }).artist
    this.setData({ view: 'albums', selectedArtist: artist, albumList: [] })
    this._loadAlbums(artist)
  },

  // ── Album list ───────────────────────────────────────────────────────────────
  _loadAlbums(artist: Artist) {
    this.setData({ albumLoading: true })
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: {
        action:     'list_admin_albums',
        artistId:   artist.artistId,
        artistName: artist.artistName,
      },
      success: (res: any) => {
        const r = res.result
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
      name: 'manageCandidates',
      data: { action: 'toggle_album_approved', albumId: id, approved: newApproved },
      success: (res: any) => {
        const toggling = { ...this.data.toggling }
        delete toggling[id]
        if (res.result && res.result.success) {
          const albumList = this.data.albumList.map((a: Album) =>
            a._id === id ? { ...a, approved: newApproved } : a
          )
          this.setData({ albumList, toggling })
        } else {
          this.setData({ toggling })
          wx.showToast({ title: '操作失败', icon: 'error' })
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

  onUnload() {
    clearTimeout(_searchTimer)
  },
})
