import { getThemeClass } from '../../utils/theme'

const FALLBACK_TICKER_SONGS = [
  'BEATWEEN · 中文说唱', 'LATEST RELEASES · 最新专辑', 'UNDERGROUND · ALBUMS',
]

function scoreFill(score: number) { return Math.round(score / 10 * 100) + '%' }
function fmtScore(n: number): string { if (!n) return '—'; const r = Math.round(n * 10) / 10; return r === 10 ? '10' : r.toFixed(1) }
function safeCallFunction(name: string, data: Record<string, any>) {
  return wx.cloud.callFunction({ name, data }).then((res: any) => res.result || { success: false }).catch((err: any) => { console.warn(`${name} failed`, err); return { success: false } })
}

Page({
  data: { statusBarHeight: 20, topbarHeight: 64, themeClass: '', tickerSongs: FALLBACK_TICKER_SONGS, loading: true, heroLabel: '今日热评专辑', heroList: [] as any[], onThisDayList: [] as any[], chartItems: [] as any[], newReleases: [] as any[], reviews: [] as any[], totalAlbums: 0, totalArtists: 0, totalReviews: 0 },
  onLoad() { const app = getApp<IAppOption>(); this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight }) },
  onShow() { if (typeof this.getTabBar === 'function') this.getTabBar()?.setData({ selected: 0 }); this.setData({ themeClass: getThemeClass() }); this._loadData() },
  _loadData() {
    this.setData({ loading: true })
    const p1 = safeCallFunction('getCharts', { limit: 5 })
    const p2 = safeCallFunction('getReviews', { recent: true, pageSize: 4 })
    const p3 = safeCallFunction('getCatalogStats', {})
    const p4 = safeCallFunction('getLatestAlbums', { limit: 12 })
    const p5 = safeCallFunction('getReviews', { dailyHotAlbums: true, limit: 6 })
    const p6 = safeCallFunction('getArtists', { limit: 1 })
    const p7 = safeCallFunction('getReviews', { totalCount: true })
    const p8 = safeCallFunction('getOnThisDay', { limit: 8 })
    Promise.all([p1, p2, p3, p4, p5, p6, p7, p8]).then((results: any[]) => {
      const chartsRes = results[0], reviewsRes = results[1], totalRes = results[2], latestRes = results[3], dailyHotRes = results[4], artistsRes = results[5], reviewCountRes = results[6], onThisDayRes = results[7]
      const chartItems = chartsRes.success ? (chartsRes.list || []).map((item: any) => ({ ...item, year: item.year || item.releaseYear, scoreDisplay: fmtScore(item.score) })) : []
      const topItem = chartItems[0] || null
      const dailyAlbums = dailyHotRes?.success ? (dailyHotRes.albums || (dailyHotRes.album ? [dailyHotRes.album] : [])) : []
      const latestList = latestRes?.success ? (latestRes.list || []) : []

      const heroList: any[] = dailyAlbums.slice(0, 6).map((a: any) => ({ albumId: a.albumId, title: a.title, coverUrl: a.coverUrl || '' }))
      let heroLabel = '今日热评专辑'
      if (heroList.length < 6 && latestList.length) {
        const used = new Set(heroList.map((a: any) => String(a.albumId)))
        const fillers = latestList.filter((a: any) => !used.has(String(a.albumId))).slice(0, 6 - heroList.length)
        heroList.push(...fillers.map((a: any) => ({ albumId: a.albumId, title: a.title, coverUrl: a.coverUrl || '' })))
        if (!dailyAlbums.length) heroLabel = '最新发行'
      }
      if (!heroList.length && topItem) {
        heroList.push({ albumId: topItem.albumId, title: topItem.title, coverUrl: topItem.coverUrl || '' })
        heroLabel = '热门榜单'
      }

      const newReleases = latestRes?.success ? (latestRes.list || []).slice(0, 10).map((a: any) => ({
        albumId: a.albumId, title: a.title, coverUrl: a.coverUrl || '',
      })) : []
      const tickerSongs = latestRes?.success && latestRes.tickerSongs?.length ? latestRes.tickerSongs : FALLBACK_TICKER_SONGS
      const onThisDayList = onThisDayRes?.success ? (onThisDayRes.list || []).map((a: any) => ({ albumId: a.albumId, title: a.title, coverUrl: a.coverUrl || '' })) : []
      this.setData({ tickerSongs, heroLabel, heroList, onThisDayList, chartItems, newReleases, reviews: reviewsRes.success ? (reviewsRes.list || []) : [], totalAlbums: totalRes.success ? (totalRes.totalAlbums || 0) : 0, totalArtists: artistsRes.success ? (artistsRes.total || 0) : 0, totalReviews: reviewCountRes.success ? (reviewCountRes.total || 0) : 0, loading: false })
    }).catch((err: any) => { console.error('home _loadData error', err); this.setData({ loading: false }) })
  },
  onChartMore() { wx.switchTab({ url: '/pages/charts/index' }) },
  onReleasesMore() { wx.navigateTo({ url: '/pages/recent-releases/index' }) },
  onAlbumTap(e: WechatMiniprogram.TouchEvent) { const id = (e.currentTarget.dataset as any).id; if (id) wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` }) },
  onReviewTap(e: WechatMiniprogram.TouchEvent) { const id = (e.currentTarget.dataset as any).id; if (id) wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` }) },
  onSearchTap() { wx.switchTab({ url: '/pages/discover/index' }) },
  onReviewMore() { wx.navigateTo({ url: '/pages/recent-reviews/index' }) },
})
