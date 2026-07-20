import { getThemeClass } from '../../utils/theme'

type AlbumAdminSection = 'library' | 'pending' | 'qqsync' | 'ownership' | 'hidden' | 'type'

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    pendingCount: 0,
    qqReadyCount: 0,
    ownershipCount: 0,
    hiddenCount: 0,
    typeCount: 0,
    loading: false,
  },
  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
  },
  onShow() {
    this.setData({ themeClass: getThemeClass() })
    this._loadCounts()
  },
  onBack() { wx.navigateBack() },
  _loadCounts() {
    this.setData({ loading: true })
    Promise.allSettled([
      wx.cloud.callFunction({ name: 'manageAlbumCandidates', data: { action: 'stats' } }),
      wx.cloud.callFunction({ name: 'manageQQAlbumCache', data: { action: 'stats' } }),
      wx.cloud.callFunction({ name: 'manageAlbumOwnershipCorrections', data: { action: 'stats' } }),
      wx.cloud.callFunction({ name: 'manageAlbumTypeCorrections', data: { action: 'stats' } }),
    ]).then((results: any[]) => {
      const p = results[0]?.status === 'fulfilled' ? results[0].value?.result : null
      const q = results[1]?.status === 'fulfilled' ? results[1].value?.result : null
      const o = results[2]?.status === 'fulfilled' ? results[2].value?.result : null
      const t = results[3]?.status === 'fulfilled' ? results[3].value?.result : null
      this.setData({
        pendingCount: p?.success ? (p.pending || 0) : 0,
        hiddenCount: p?.success ? Number(p.hidden || 0) + Number(p.legacyHidden || 0) : 0,
        qqReadyCount: q?.success ? (q.ready || 0) : 0,
        ownershipCount: o?.success ? (o.pending || 0) : 0,
        typeCount: t?.success ? (t.pending || 0) : 0,
        loading: false,
      })
    })
  },
  onSectionTap(e: WechatMiniprogram.TouchEvent) {
    const section = (e.currentTarget.dataset as { section: AlbumAdminSection }).section
    const routes: Record<AlbumAdminSection, string> = {
      library: '/pages/album-manager/index',
      pending: '/pages/album-candidates/index',
      qqsync: '/pages/qq-album-sync/index',
      ownership: '/pages/ownership-corrections/index',
      hidden: '/pages/album-candidates/index?mode=hidden',
      type: '/pages/type-corrections/index',
    }
    wx.navigateTo({ url: routes[section] })
  },
})
