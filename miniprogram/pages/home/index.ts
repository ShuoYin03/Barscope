import { getThemeClass } from '../../utils/theme'

const FALLBACK_TICKER_SONGS = [
  'SOUNDIVE · 中文说唱', 'LATEST RELEASES · 最新专辑', 'UNDERGROUND · ALBUMS',
]

const HERO_CARD_HEIGHT_BASE = 600
const HERO_CARD_HEIGHT_HOT = 720

function fmtScore(n: number): string { if (!n) return '—'; const r = Math.round(n * 10) / 10; return r === 10 ? '10' : r.toFixed(1) }
function fmtReleaseDate(value: any, fallbackYear?: any): string {
  const raw = String(value || '').trim()
  const match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (match) {
    const [, year, month, day] = match
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`
  }
  return String(fallbackYear || '').trim()
}
function safeCallFunction(name: string, data: Record<string, any>) {
  return wx.cloud.callFunction({ name, data }).then((res: any) => res.result || { success: false }).catch((err: any) => { console.warn(`${name} failed`, err); return { success: false } })
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    tickerSongs: FALLBACK_TICKER_SONGS,
    loading: true,
    isLoggedIn: false,
    recentHotItems: [] as any[],
    heroSwiperList: [] as any[],
    heroSwiperHeight: HERO_CARD_HEIGHT_BASE,
    chartItems: [] as any[],
    newReleases: [] as any[],
    reviews: [] as any[],
    followingFeedList: [] as any[],
    topCritics: [] as any[],
    totalAlbums: 0,
    totalArtists: 0,
    totalReviews: 0,
  },
  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
  },
  onShow() {
    if (typeof this.getTabBar === 'function') this.getTabBar()?.setData({ selected: 0 })
    const app = getApp<IAppOption>()
    this.setData({ themeClass: getThemeClass(), isLoggedIn: !!app.globalData.userInfo })
    this._loadData()
  },
  _loadData() {
    this.setData({ loading: true })
    const requests = [
      safeCallFunction('getCharts', { limit: 5 }),
      safeCallFunction('getReviews', { recent: true, pageSize: 4 }),
      safeCallFunction('getCatalogStats', {}),
      safeCallFunction('getLatestAlbums', { limit: 10 }),
      safeCallFunction('getReviews', { dailyHotAlbums: true, limit: 6 }),
      safeCallFunction('getArtists', { limit: 1 }),
      safeCallFunction('getReviews', { totalCount: true }),
      safeCallFunction('getOnThisDay', { limit: 8 }),
      safeCallFunction('getReviews', { monthlyTopCritics: true, limit: 8 }),
      safeCallFunction('getReviews', { followingFeed: true, pageSize: 6 }),
      safeCallFunction('getRecentHotAlbums', { limit: 5, days: 30 }),
    ]

    Promise.all(requests).then((results: any[]) => {
      const [chartsRes, reviewsRes, totalRes, latestRes, dailyHotRes, artistsRes, reviewCountRes, onThisDayRes, topCriticsRes, followingFeedRes, recentHotRes] = results

      const chartItems = chartsRes.success
        ? (chartsRes.list || []).map((item: any) => ({ ...item, year: item.year || item.releaseYear, scoreDisplay: fmtScore(item.score) }))
        : []

      const dailyAlbums = dailyHotRes?.success
        ? (dailyHotRes.albums || (dailyHotRes.album ? [dailyHotRes.album] : []))
        : []

      const recentHotSource = recentHotRes?.success && recentHotRes.list?.length ? recentHotRes.list : chartItems
      const recentHotItems = recentHotSource.slice(0, 5).map((a: any, index: number) => ({
        albumId: a.albumId || a._id,
        title: a.title || a.albumTitle || '',
        artist: a.artist || '',
        rank: index + 1,
        scoreDisplay: fmtScore(Number(a.avgScore || a.score || 0)),
        reviewCount: Number(a.reviewCount || 0),
      }))

      const latestList = latestRes?.success ? (latestRes.list || []) : []
      const newReleases = latestList.slice(0, 10).map((a: any) => ({
        albumId: a.albumId,
        title: a.title,
        artist: a.artist || '',
        coverUrl: a.coverUrl || '',
        dateDisplay: fmtReleaseDate(a.releaseDate, a.releaseYear),
      }))

      const tickerSongs = latestRes?.success && latestRes.tickerSongs?.length ? latestRes.tickerSongs : FALLBACK_TICKER_SONGS

      const todayHotSwiperItems = dailyAlbums.slice(0, 6).map((a: any) => ({
        albumId: a.albumId,
        title: a.title,
        artist: a.artist || '',
        year: a.year || '',
        score: fmtScore(Number(a.score || 0)),
        coverUrl: a.coverUrl || '',
        kicker: '今日热议',
        isTodayHot: true,
        todayReviewCount: Number(a.todayReviewCount || 0),
        currentScore: fmtScore(Number(a.score || 0)),
        cardHeight: HERO_CARD_HEIGHT_HOT,
      }))

      const onThisDaySwiperItems = onThisDayRes?.success
        ? (onThisDayRes.list || []).map((a: any) => ({
            albumId: a.albumId,
            title: a.title,
            artist: a.artist,
            year: a.releaseYear,
            score: fmtScore(a.avgScore),
            coverUrl: a.coverUrl || '',
            kicker: `历史上的今天 · ${a.yearsAgo}年前`,
            isTodayHot: false,
            cardHeight: HERO_CARD_HEIGHT_BASE,
          }))
        : []

      const heroSwiperList = [...todayHotSwiperItems, ...onThisDaySwiperItems]

      const topCritics = topCriticsRes?.success
        ? (topCriticsRes.list || []).map((c: any) => ({ ...c, initial: c.nickName ? c.nickName[0] : '?' }))
        : []

      const followingFeedList = followingFeedRes?.success
        ? (followingFeedRes.list || []).map((r: any) => ({
            _id: r._id,
            authorOpenId: r.authorOpenId || '',
            userName: r.userName,
            initial: r.initial,
            userType: r.userType,
            timeAgo: r.timeAgo,
            albumId: r.albumId,
            albumTitle: r.albumTitle,
            ratingText: r.rating ? Number(r.rating).toFixed(1) : '—',
            content: r.content,
          }))
        : []

      this.setData({
        tickerSongs,
        recentHotItems,
        heroSwiperList,
        heroSwiperHeight: heroSwiperList[0]?.cardHeight || HERO_CARD_HEIGHT_BASE,
        chartItems,
        newReleases,
        reviews: reviewsRes.success ? (reviewsRes.list || []) : [],
        followingFeedList,
        topCritics,
        totalAlbums: totalRes.success ? (totalRes.totalAlbums || 0) : 0,
        totalArtists: artistsRes.success ? (artistsRes.total || 0) : 0,
        totalReviews: reviewCountRes.success ? (reviewCountRes.total || 0) : 0,
        loading: false,
      })
    }).catch((err: any) => {
      console.error('home _loadData error', err)
      this.setData({ loading: false })
    })
  },
  onHeroSwiperChange(e: WechatMiniprogram.SwiperChange) {
    const index = e.detail.current
    const height = this.data.heroSwiperList[index]?.cardHeight || HERO_CARD_HEIGHT_BASE
    if (height !== this.data.heroSwiperHeight) this.setData({ heroSwiperHeight: height })
  },
  onChartMore() { wx.switchTab({ url: '/pages/charts/index' }) },
  onReleasesMore() { wx.navigateTo({ url: '/pages/recent-releases/index' }) },
  onAlbumTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as any).id
    if (id) wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
  },
  onReviewTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as any).id
    if (id) wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
  },
  onSearchTap() { wx.switchTab({ url: '/pages/discover/index' }) },
  onReviewMore() { wx.navigateTo({ url: '/pages/recent-reviews/index' }) },
  onCriticTap(e: WechatMiniprogram.TouchEvent) {
    const openId = (e.currentTarget.dataset as any).openId
    if (openId) wx.navigateTo({ url: `/pages/user/index?openId=${openId}` })
  },
  onFollowingFeedMore() { wx.navigateTo({ url: '/pages/notifications/index' }) },
  onGoLogin() { wx.navigateTo({ url: '/pages/login/index' }) },
})