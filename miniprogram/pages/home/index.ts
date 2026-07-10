const FALLBACK_TICKER_SONGS = [
  'BARSCOPE · 中文说唱', 'LATEST RELEASES · 最新专辑', 'UNDERGROUND · ALBUMS',
]

const GENRES = [
  { name: 'Trap', count: '—张' }, { name: 'Old School', count: '—张' }, { name: 'Drill', count: '—张' },
  { name: 'Lo-fi', count: '—张' }, { name: '硬核', count: '—张' }, { name: '融合', count: '—张' },
]

function scoreFill(score: number) { return Math.round(score / 10 * 100) + '%' }
function fmtScore(n: number): string { if (!n) return '—'; const r = Math.round(n * 10) / 10; return r === 10 ? '10' : r.toFixed(1) }
function safeCallFunction(name: string, data: Record<string, any>) {
  return wx.cloud.callFunction({ name, data }).then((res: any) => res.result || { success: false }).catch((err: any) => { console.warn(`${name} failed`, err); return { success: false } })
}

Page({
  data: { statusBarHeight: 20, topbarHeight: 64, tickerSongs: FALLBACK_TICKER_SONGS, loading: true, hero: null as any, heroScoreFill: '0%', chartItems: [] as any[], newReleases: [] as any[], genres: GENRES, reviews: [] as any[], totalAlbums: 0 },
  onLoad() { const app = getApp<IAppOption>(); this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight }) },
  onShow() { if (typeof this.getTabBar === 'function') this.getTabBar()?.setData({ selected: 0 }); this._loadData() },
  _loadData() {
    this.setData({ loading: true })
    const p1 = safeCallFunction('getCharts', { limit: 5 })
    const p2 = safeCallFunction('getReviews', { recent: true, pageSize: 4 })
    const p3 = safeCallFunction('getAlbums', { pageSize: 1 })
    const p4 = safeCallFunction('getLatestAlbums', { limit: 12 })
    const p5 = safeCallFunction('getReviews', { dailyHotAlbum: true })
    Promise.all([p1, p2, p3, p4, p5]).then((results: any[]) => {
      const chartsRes = results[0], reviewsRes = results[1], totalRes = results[2], latestRes = results[3], dailyHotRes = results[4]
      const chartItems = chartsRes.success ? (chartsRes.list || []).map((item: any) => ({ ...item, year: item.year || item.releaseYear, scoreDisplay: fmtScore(item.score) })) : []
      const topItem = chartItems[0] || null
      const dailyAlbum = dailyHotRes?.success ? dailyHotRes.album : null
      const hero = dailyAlbum
        ? {
            albumId: dailyAlbum.albumId,
            title: dailyAlbum.title,
            artist: dailyAlbum.artist,
            year: dailyAlbum.year,
            score: fmtScore(dailyAlbum.score),
            scoreFill: scoreFill(dailyAlbum.score),
            coverUrl: dailyAlbum.coverUrl || '',
            genres: dailyAlbum.genres || [],
            todayReviewCount: Number(dailyAlbum.todayReviewCount || dailyHotRes.reviewCount || 0),
            heroSource: 'dailyReviews',
          }
        : topItem
          ? { albumId: topItem.albumId, title: topItem.title, artist: topItem.artist, year: topItem.year, score: fmtScore(topItem.score), scoreFill: scoreFill(topItem.score), coverUrl: topItem.coverUrl || '', genres: [], todayReviewCount: 0, heroSource: 'chartFallback' }
          : null
      const newReleases = latestRes?.success ? (latestRes.list || []).slice(0, 4).map((a: any, i: number) => ({
        albumId: a.albumId, rank: String(i + 1).padStart(2, '0'), title: a.title, artist: a.artist,
        year: a.releaseDate || a.releaseYear, scoreDisplay: 'NEW', score: 0, scoreFill: '0%', coverUrl: a.coverUrl || '', isThisWeek: !!a.isThisWeek,
      })) : []
      const tickerSongs = latestRes?.success && latestRes.tickerSongs?.length ? latestRes.tickerSongs : FALLBACK_TICKER_SONGS
      this.setData({ tickerSongs, hero, heroScoreFill: hero ? hero.scoreFill : '0%', chartItems, newReleases, reviews: reviewsRes.success ? (reviewsRes.list || []) : [], totalAlbums: totalRes.success ? (totalRes.total || 0) : 0, loading: false })
    }).catch((err: any) => { console.error('home _loadData error', err); this.setData({ loading: false }) })
  },
  onChartMore() { wx.switchTab({ url: '/pages/charts/index' }) },
  onReleasesMore() { wx.navigateTo({ url: '/pages/recent-releases/index' }) },
  onGenreMore() { wx.switchTab({ url: '/pages/discover/index' }) },
  onGenreTap() { wx.switchTab({ url: '/pages/discover/index' }) },
  onAlbumTap(e: WechatMiniprogram.TouchEvent) { const id = (e.currentTarget.dataset as any).id; if (id) wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` }) },
  onSearchTap() { wx.switchTab({ url: '/pages/discover/index' }) },
  onHeroTap() { const hero = this.data.hero; if (hero?.albumId) wx.navigateTo({ url: `/pages/album-detail/index?id=${hero.albumId}` }) },
  onReviewMore() { wx.showToast({ title: '评论功能开发中', icon: 'none' }) },
  onRegister() { wx.navigateTo({ url: '/pages/login/index' }) },
  onLearnMore() { wx.showToast({ title: '了解更多开发中', icon: 'none' }) },
})
