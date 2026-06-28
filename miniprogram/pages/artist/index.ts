interface ArtistAlbum {
  id:         string
  title:      string
  year:       number
  trackCount: number
  score:      number
  coverUrl:   string
}

Page({
  data: {
    statusBarHeight: 20,
    artistName:      '',
    initial:         '',
    bannerUrl:       '',
    avatarUrl:       '',
    total:           0,
    avgScore:        '–',
    yearRange:       '',
    list:            [] as ArtistAlbum[],
    loading:         true,
  },

  onLoad(options: Record<string, string>) {
    const app = getApp<IAppOption>()
    const artistId   = options.artistId   || ''
    const artistName = decodeURIComponent(options.artistName || '')
    const initial    = (artistName.match(/[A-Za-z]/) ? artistName[0] : artistName[0]) || '?'

    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      artistName,
      initial: initial.toUpperCase(),
    })

    this._loadArtist(artistId)
    this._loadAlbums(artistId)
  },

  _loadArtist(artistId: string) {
    wx.cloud.callFunction({
      name: 'getArtist',
      data: { artistId },
      success: (res: any) => {
        const artist = res.result?.artist
        if (!artist) return
        const bannerUrl = artist.backgroundUrl || artist.coverUrl || artist.picUrl || artist.avatarUrl || ''
        const avatarUrl = artist.picUrl || artist.avatarUrl || artist.backgroundUrl || artist.coverUrl || ''
        this.setData({ bannerUrl, avatarUrl })
      },
    } as any)
  },

  _loadAlbums(artistId: string) {
    wx.cloud.callFunction({
      name: 'getAlbums',
      data: { artistId, pageSize: 100 },
      success: (res: any) => {
        const result = res.result
        if (!result?.success) { this.setData({ loading: false }); return }

        const rawList: any[] = result.list || []
        const list: ArtistAlbum[] = rawList.map((a: any) => ({
          id:         a._id,
          title:      a.title       || '',
          year:       a.releaseYear || 0,
          trackCount: a.trackCount  || 0,
          score:      Math.round((a.avgScore || 0) * 10) / 10,
          coverUrl:   a.coverUrl    || '',
        })).sort((a, b) => b.year - a.year)

        const scored = list.filter(a => a.score > 0)
        const avgScore = scored.length
          ? (scored.reduce((s, a) => s + a.score, 0) / scored.length).toFixed(1)
          : '–'

        const years = list.map(a => a.year).filter(Boolean)
        const yearRange = years.length
          ? (Math.min(...years) === Math.max(...years)
              ? String(Math.min(...years))
              : `${Math.min(...years)}–${Math.max(...years)}`)
          : ''

        this.setData({ list, total: list.length, avgScore, yearRange, loading: false })
      },
      fail: () => {
        this.setData({ loading: false })
      },
    } as any)
  },

  onBack() {
    wx.navigateBack()
  },

  onAlbumTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id
    wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
  },
})
