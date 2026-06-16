interface AlbumCard {
  id:        string
  title:     string
  artist:    string
  year:      number
  score:     number
  genres:    string[]
  scoreFill: string
  coverUrl:  string
}

const GENRES = [
  { name: 'Trap',       count: '—' },
  { name: 'Old School', count: '—' },
  { name: 'Drill',      count: '—' },
  { name: 'Lo-fi',      count: '—' },
  { name: 'Conscious',  count: '—' },
  { name: '硬核',       count: '—' },
  { name: '情感',       count: '—' },
  { name: '融合',       count: '—' },
]

function mapAlbum(a: any): AlbumCard {
  const score = a.avgScore || 0
  return {
    id:        a._id,
    title:     a.title    || '',
    artist:    a.artist   || '',
    year:      a.releaseYear || 0,
    score:     Math.round(score * 10) / 10,
    genres:    a.genres   || [],
    scoreFill: Math.round(score / 10 * 100) + '%',
    coverUrl:  a.coverUrl || '',
  }
}

let _searchTimer: any = null

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,
    keyword:         '',
    genres:          GENRES,
    activeGenre:     '',
    list:            [] as AlbumCard[],
    total:           0,
    loading:         false,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight:    app.globalData.topbarHeight,
    })
    this._fetchAlbums({ pageSize: 30 })
  },

  onShow() {
    if (typeof this.getTabBar === 'function') {
      this.getTabBar().setData({ selected: 2 })
    }
  },

  _fetchAlbums(params: Record<string, any>) {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'getAlbums',
      data: params,
      success: (res: any) => {
        const result = res.result
        if (!result.success) { this.setData({ loading: false }); return }
        const list = (result.list || []).map(mapAlbum)
        this.setData({ list, total: result.total || list.length, loading: false })
      },
      fail: () => {
        this.setData({ loading: false })
      },
    } as any)
  },

  onSearch(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value
    this.setData({ keyword })

    // debounce 400ms
    if (_searchTimer) clearTimeout(_searchTimer)
    _searchTimer = setTimeout(() => {
      const genre = this.data.activeGenre
      if (keyword.trim()) {
        this._fetchAlbums({ keyword: keyword.trim(), genre: genre || undefined })
      } else {
        this._fetchAlbums({ genre: genre || undefined, pageSize: 30 })
      }
    }, 400)
  },

  onGenreTap(e: WechatMiniprogram.TouchEvent) {
    const genre  = (e.currentTarget.dataset as { genre: string }).genre
    const active = this.data.activeGenre === genre ? '' : genre
    this.setData({ activeGenre: active })

    const kw = this.data.keyword.trim()
    if (kw) {
      this._fetchAlbums({ keyword: kw, genre: active || undefined })
    } else {
      this._fetchAlbums({ genre: active || undefined, pageSize: 30 })
    }
  },

  onAlbumTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id
    wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
  },
})
