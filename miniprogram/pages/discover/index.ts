interface AlbumCard {
  id:              string
  title:           string
  artist:          string
  primaryArtist:   string
  neteaseArtistId: string
  year:            number
  score:           number
  genres:          string[]
  scoreFill:       string
  coverUrl:        string
}

interface ArtistCard {
  id:         string
  artistId:   string
  artistName: string
  picUrl:     string
  albumSize:  number
  fansSize:   number
  letter:     string
}

interface ArtistGroup {
  letter: string
  list:   ArtistCard[]
}

const YEARS = [
  { name: '2025' },
  { name: '2024' },
  { name: '2023' },
  { name: '2022' },
  { name: '2021' },
  { name: '2020' },
  { name: '2019' },
  { name: '2018' },
  { name: '2010s' },
  { name: '2000s' },
]

function mapAlbum(a: any): AlbumCard {
  const score = a.avgScore || 0
  return {
    id:              a._id,
    title:           a.title          || '',
    artist:          a.artist         || '',
    primaryArtist:   a.primaryArtist  || (a.artist || '').split(/[,，&]/)[0].trim(),
    neteaseArtistId: String(a.neteaseArtistId || ''),
    year:            a.releaseYear    || 0,
    score:           Math.round(score * 10) / 10,
    genres:          a.genres         || [],
    scoreFill:       Math.round(score / 10 * 100) + '%',
    coverUrl:        a.coverUrl       || '',
  }
}

function groupArtists(list: ArtistCard[]): ArtistGroup[] {
  const map: Record<string, ArtistCard[]> = {}
  list.forEach((artist) => {
    const key = artist.letter || '#'
    if (!map[key]) map[key] = []
    map[key].push(artist)
  })
  return Object.keys(map).sort().map((letter) => ({ letter, list: map[letter] }))
}

let _searchTimer: any = null

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,
    keyword:         '',
    viewMode:        'albums' as 'albums' | 'artists',
    years:           YEARS,
    activeYear:      '',
    list:            [] as AlbumCard[],
    total:           0,
    loading:         false,
    artistList:      [] as ArtistCard[],
    artistGroups:    [] as ArtistGroup[],
    artistTotal:     0,
    artistLoading:   false,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight:    app.globalData.topbarHeight,
    })
    this._fetchAlbums({ pageSize: 30 })
    this._fetchArtists()
  },

  onShow() {
    if (typeof this.getTabBar === 'function') {
      this.getTabBar()?.setData({ selected: 2 })
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
      fail: () => this.setData({ loading: false }),
    } as any)
  },

  _fetchArtists(keyword = '') {
    this.setData({ artistLoading: true })
    wx.cloud.callFunction({
      name: 'getArtists',
      data: { keyword, limit: 500 },
      success: (res: any) => {
        const result = res.result || {}
        if (!result.success) { this.setData({ artistLoading: false }); return }
        const artistList = (result.list || []) as ArtistCard[]
        this.setData({
          artistList,
          artistGroups: groupArtists(artistList),
          artistTotal: result.total || artistList.length,
          artistLoading: false,
        })
      },
      fail: () => this.setData({ artistLoading: false }),
    } as any)
  },

  onViewModeTap(e: WechatMiniprogram.TouchEvent) {
    const mode = (e.currentTarget.dataset as { mode: 'albums' | 'artists' }).mode
    if (mode === this.data.viewMode) return
    this.setData({ viewMode: mode })
  },

  onSearch(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value
    this.setData({ keyword })

    if (_searchTimer) clearTimeout(_searchTimer)
    _searchTimer = setTimeout(() => {
      const kw = keyword.trim()
      if (this.data.viewMode === 'artists') {
        this._fetchArtists(kw)
        return
      }
      const year = this.data.activeYear
      if (kw) {
        this._fetchAlbums({ keyword: kw, year: year || undefined })
      } else {
        this._fetchAlbums({ year: year || undefined, pageSize: 30 })
      }
    }, 400)
  },

  onYearTap(e: WechatMiniprogram.TouchEvent) {
    const year   = (e.currentTarget.dataset as { year: string }).year
    const active = this.data.activeYear === year ? '' : year
    this.setData({ activeYear: active })

    const kw = this.data.keyword.trim()
    if (kw) {
      this._fetchAlbums({ keyword: kw, year: active || undefined })
    } else {
      this._fetchAlbums({ year: active || undefined, pageSize: 30 })
    }
  },

  onAlbumTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id
    wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
  },

  onArtistTap(e: WechatMiniprogram.TouchEvent) {
    const ds = e.currentTarget.dataset as { artistId: string; artist: string }
    if (!ds.artistId) return
    wx.navigateTo({
      url: `/pages/artist/index?artistId=${ds.artistId}&artistName=${encodeURIComponent(ds.artist)}`,
    })
  },
})
