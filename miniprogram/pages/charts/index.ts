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

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function fmtMonthDay(date: Date): string {
  return `${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`
}

function buildPeriodSubtitle(period: Period, now = new Date()): string {
  const year = now.getFullYear()

  if (period === 'weekly') {
    const day = now.getDay()
    const mondayOffset = day === 0 ? -6 : 1 - day
    const monday = new Date(year, now.getMonth(), now.getDate() + mondayOffset)
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
    return `${fmtMonthDay(monday)}–${fmtMonthDay(sunday)} · 用户评分`
  }

  if (period === 'monthly') {
    const first = new Date(year, now.getMonth(), 1)
    const last = new Date(year, now.getMonth() + 1, 0)
    return `${fmtMonthDay(first)}–${fmtMonthDay(last)} · 用户评分`
  }

  if (period === 'annual') {
    return `${year}.01–${year}.12 · 累计评分`
  }

  return '2026 年发行 · 已评分专辑'
}

interface ChartEntry {
  rank: number
  albumId: string
  title: string
  artist: string
  year: number
  releaseDate: string
  dateDisplay: string
  score: number
  scoreDisplay: string
}

import { getThemeClass } from '../../utils/theme'

const PERIOD_META: Record<Period, { label: string }> = {
  weekly:      { label: '周榜' },
  monthly:     { label: '月榜' },
  annual:      { label: '年榜' },
  release2026: { label: '2026榜单' },
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    period: 'weekly' as Period,
    periodSubtitle: buildPeriodSubtitle('weekly'),
    periods: (Object.keys(PERIOD_META) as Period[]).map(key => ({ key, label: PERIOD_META[key].label })),
    list: [] as ChartEntry[],
    loading: true,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
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
    this.setData({ loading: true, list: [], periodSubtitle: buildPeriodSubtitle(period) })

    wx.cloud.callFunction({
      name: 'getCharts',
      data: { period, limit: 30 },
      success: (res: any) => {
        const result = res.result || {}
        if (!result.success) {
          this.setData({ list: [], loading: false })
          wx.showToast({ title: result.error || '加载失败', icon: 'none' })
          return
        }

        let rawList = (result.list || []).filter((item: any) => Number(item.score || 0) > 0)
        if (period === 'release2026') rawList = rawList.filter(isReleasedIn2026)

        const list: ChartEntry[] = rawList.slice(0, 30).map((item: any, index: number) => {
          const year = item.year || item.releaseYear
          return {
            ...item,
            rank: index + 1,
            year,
            dateDisplay: fmtReleaseDate(item.releaseDate, year),
            scoreDisplay: fmtScore(Number(item.score || 0)),
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
    if (id) wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
  },
})