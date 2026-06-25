const TICKER_SONGS = [
  '光明 · GAI', 'SOUTH SIDE · VAVA', '无处不在 · Tizzy T',
  'Intro · 艾福杰尼', '野外 · 那吾克热', '病态 · GALI',
]

const GENRES = [
  { name: 'Trap',       count: '—张' },
  { name: 'Old School', count: '—张' },
  { name: 'Drill',      count: '—张' },
  { name: 'Lo-fi',      count: '—张' },
  { name: '硬核',       count: '—张' },
  { name: '融合',       count: '—张' },
]

function scoreFill(score: number) {
  return Math.round(score / 10 * 100) + '%'
}

function fmtScore(n: number): string {
  if (!n) return '—'
  const r = Math.round(n * 10) / 10
  if (r === 10) return '10'
  return r.toFixed(1)
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,
    tickerSongs:     TICKER_SONGS,
    loading:         true,
    hero:            null as any,
    heroScoreFill:   '0%',
    chartItems:      [] as any[],
    newReleases:     [] as any[],
    genres:          GENRES,
    reviews:         [] as any[],
    totalAlbums:     0,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight:    app.globalData.topbarHeight,
    })
    this._loadData()
  },

  onShow() {
    if (typeof this.getTabBar === 'function') {
      this.getTabBar()?.setData({ selected: 0 })
    }
  },

  _loadData() {
    // charts top 5
    const p1 = wx.cloud.callFunction({ name: 'getCharts', data: { limit: 5 } })
    // new releases (by releaseYear)
    const p2 = wx.cloud.callFunction({ name: 'getAlbums', data: { sortBy: 'releaseYear', pageSize: 4 } })
    // recent reviews
    const p3 = wx.cloud.callFunction({ name: 'getReviews', data: { recent: true, pageSize: 4 } })
    // total album count
    const p4 = wx.cloud.callFunction({ name: 'getAlbums', data: { pageSize: 1 } })

    Promise.all([p1, p2, p3, p4]).then((results: any[]) => {
      const chartsRes  = results[0].result
      const releasesRes = results[1].result
      const reviewsRes = results[2].result
      const totalRes   = results[3].result

      // chart items
      const chartItems = chartsRes.success
        ? (chartsRes.list || []).map((item: any) => ({
            ...item,
            year:         item.year || item.releaseYear,
            scoreDisplay: fmtScore(item.score),
          }))
        : []

      // hero = top chart item
      const topItem = chartItems[0] || null
      const hero = topItem ? {
        albumId:      topItem.albumId,
        title:        topItem.title,
        artist:       topItem.artist,
        year:         topItem.year,
        score:        fmtScore(topItem.score),
        scoreFill:    scoreFill(topItem.score),
        coverUrl:     topItem.coverUrl || '',
        genres:       [],
      } : null

      // new releases
      const newReleases = releasesRes.success
        ? (releasesRes.list || []).slice(0, 4).map((a: any, i: number) => ({
            albumId:      a._id,
            rank:         String(i + 1).padStart(2, '0'),
            title:        a.title,
            artist:       a.artist,
            year:         a.releaseYear,
            scoreDisplay: fmtScore(a.avgScore || 0),
            score:        a.avgScore || 0,
            scoreFill:    scoreFill(a.avgScore || 0),
            coverUrl:     a.coverUrl || '',
          }))
        : []

      // recent reviews
      const reviews = reviewsRes.success ? (reviewsRes.list || []) : []

      const totalAlbums = totalRes.success ? (totalRes.total || 0) : 0

      this.setData({
        hero,
        heroScoreFill: hero ? hero.scoreFill : '0%',
        chartItems,
        newReleases,
        reviews,
        totalAlbums,
        loading: false,
      })
    }).catch((err: any) => {
      console.error('home _loadData error', err)
      this.setData({ loading: false })
    })
  },

  onChartMore() {
    wx.switchTab({ url: '/pages/charts/index' })
  },

  onReleasesMore() {
    wx.switchTab({ url: '/pages/discover/index' })
  },

  onGenreMore() {
    wx.switchTab({ url: '/pages/discover/index' })
  },

  onGenreTap(e: WechatMiniprogram.TouchEvent) {
    wx.switchTab({ url: '/pages/discover/index' })
  },

  onAlbumTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as any).id
    if (id) {
      wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
    }
  },

  onSearchTap() {
    wx.switchTab({ url: '/pages/discover/index' })
  },

  onHeroTap() {
    const hero = this.data.hero
    if (hero && hero.albumId) {
      wx.navigateTo({ url: `/pages/album-detail/index?id=${hero.albumId}` })
    }
  },

  onReviewMore() {
    wx.showToast({ title: '评论功能开发中', icon: 'none' })
  },

  onRegister() {
    wx.navigateTo({ url: '/pages/login/index' })
  },

  onLearnMore() {
    wx.showToast({ title: '了解更多开发中', icon: 'none' })
  },
})
