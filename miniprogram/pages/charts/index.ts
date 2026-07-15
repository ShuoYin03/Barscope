type Period = 'weekly' | 'monthly' | 'annual' | 'release2026'

function fmtScore(n: number): string {
  if (!n) return '—'
  const r = Math.round(n * 10) / 10
  if (r === 10) return '10'
  return r.toFixed(1)
}

function fmtReleaseDate(value: any, fallbackYear?: any): string {
  const raw = String(value || '').trim()
  const match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (match) {
    const [, year, month, day] = match
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`
  }
  const year = String(fallbackYear || '').trim()
  return year ? `—/—/${year}` : ''
}

function isReleasedIn2026(item: any): boolean {
  const releaseYear = String(item.releaseYear || item.year || '').trim()
  const releaseDate = String(item.releaseDate || '').trim()
  return releaseYear === '2026' || /^2026[-/.]/.test(releaseDate)
}

interface ChartEntry {
  rank:        number
  albumId:     string
  title:       string
  artist:      string
  year:        number
  releaseDate: string
  dateDisplay: string
  score:       number
  trendText:   string
  scoreFill:   string
}

import { getThemeClass } from '../../utils/theme'

const PERIOD_META: Record<Period, { label: string; subtitle: string; limit: number }> = {
  weekly:     { label: '周榜', subtitle: '周榜 · 全部专辑', limit: 50 },
  monthly:    { label: '月榜', subtitle: '月榜 · 全部专辑', limit: 100 },
  annual:     { label: '年榜', subtitle: '年榜 · 全部专辑', limit: 100 },
  release2026:{ label: '2026榜单', subtitle: '2026发行 · 专辑榜单', limit: 100 },
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,
    themeClass: '',
    period:  'weekly' as Period,
    periodSubtitle: PERIOD_META.weekly.subtitle,
    periods: (Object.keys(PERIOD_META) as Period[]).map(key => ({ key, label: PERIOD_META[key].label })),
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
    const meta = PERIOD_META[period]
    this.setData({ loading: true, list: [], periodSubtitle: meta.subtitle })

    wx.cloud.callFunction({
      name: 'getCharts',
      data: { period, limit: meta.limit },
      success: (res: any) => {
        const result = res.result
        if (!result.success) {
          this.setData({ list: [], loading: false })
          wx.showToast({ title: result.error || '加载失败', icon: 'none' })
          return
        }

        const rawList = period === 'release2026'
          ? (result.list || []).filter(isReleasedIn2026)
          : (result.list || [])

        const list: ChartEntry[] = rawList.map((item: any, index: number) => {
          const year = item.year || item.releaseYear
          return {
            ...item,
            rank: index + 1,
            year,
            dateDisplay: fmtReleaseDate(item.releaseDate, year),
            scoreDisplay: fmtScore(item.score),
          }
        })

        this.setData({ list, loading: false })
      },
      fail: () => {
        this.setData({ list: [], loading: false })
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
