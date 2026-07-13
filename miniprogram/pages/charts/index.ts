type Period = 'weekly' | 'monthly' | 'annual'

function fmtScore(n: number): string {
  if (!n) return '—'
  const r = Math.round(n * 10) / 10
  if (r === 10) return '10'
  return r.toFixed(1)
}

interface ChartEntry {
  rank:      number
  albumId:   string
  title:     string
  artist:    string
  year:      number
  score:     number
  trendText: string
  scoreFill: string
}

import { getThemeClass } from '../../utils/theme'

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,
    themeClass: '',
    period:  'weekly' as Period,
    periods: [
      { key: 'weekly',  label: '周榜' },
      { key: 'monthly', label: '月榜' },
      { key: 'annual',  label: '年榜' },
    ],
    list:    [] as ChartEntry[],
    loading: true,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight:    app.globalData.topbarHeight,
    })
    this._loadCharts('weekly')
  },

  onShow() {
    if (typeof this.getTabBar === 'function') {
      this.getTabBar()?.setData({ selected: 1 })
    }
    this.setData({ themeClass: getThemeClass() })
  },

  _loadCharts(period: Period) {
    this.setData({ loading: true })

    // period 差异：weekly=最近50张, monthly=最近100张, annual=全部top100
    const limitMap: Record<Period, number> = { weekly: 50, monthly: 100, annual: 100 }
    const limit = limitMap[period]

    wx.cloud.callFunction({
      name: 'getCharts',
      data: { limit },
      success: (res: any) => {
        const result = res.result
        if (!result.success) { this.setData({ loading: false }); return }

        const list: ChartEntry[] = (result.list || []).map((item: any) => ({
          ...item,
          year:         item.year || item.releaseYear,
          scoreDisplay: fmtScore(item.score),
        }))

        this.setData({ list, loading: false })
      },
      fail: () => {
        this.setData({ loading: false })
        wx.showToast({ title: '加载失败', icon: 'none' })
      },
    } as any)
  },

  onPeriod(e: WechatMiniprogram.TouchEvent) {
    const p = (e.currentTarget.dataset as { p: Period }).p
    this.setData({ period: p })
    this._loadCharts(p)
  },

  onAlbumTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as any).id
    if (id) {
      wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
    }
  },
})
