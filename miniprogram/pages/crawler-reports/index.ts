import { getThemeClass } from '../../utils/theme'

let _pollTimer: any = null

function toMillis(v: any): number {
  if (!v) return 0
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t }
  if (typeof v === 'object' && v.$date) return Number(v.$date) || 0
  return 0
}
function formatAgo(ms: number): string {
  if (!ms) return '暂无'
  const diff = Date.now() - ms
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  return Math.floor(diff / 86400000) + ' 天前'
}

Page({
  data: {
    statusBarHeight: 20,
    themeClass: '',
    // 历史
    list: [] as any[],
    loading: true,
    loadError: '',
    // 今日进度（读 crawlerAutoControl）
    control: null as any,
    failedNames: [] as string[],
    pct: 0,
    cursor: 0,
    total: 0,
    failedCount: 0,
    statusLabel: '加载中',
    statusClass: 'waiting',
    lastRunText: '暂无',
    showFailed: false,
    resetting: false,
    autoLoaded: false,
  },

  onLoad() { const app = getApp<IAppOption>(); this.setData({ statusBarHeight: app.globalData.statusBarHeight }); this.loadAll() },
  onShow() { this.setData({ themeClass: getThemeClass() }); this.loadAll(); this._startPoll() },
  onHide() { this._stopPoll() },
  onUnload() { this._stopPoll() },
  onBack() { wx.navigateBack() },

  _startPoll() { this._stopPoll(); _pollTimer = setInterval(() => this.loadAuto(), 4000) },
  _stopPoll() { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null } },

  loadAll() { this.loadAuto(); this.loadReports() },

  loadAuto() {
    wx.cloud.callFunction({
      name: 'cloudCrawlerDailyTrigger', data: { action: 'getAutoStatus' },
      success: (res: any) => {
        const r = res.result || {}; if (!r.success) { this.setData({ autoLoaded: true }); return }
        const c = r.control || {}
        const total = Number(c.total || 0)
        const cursor = Math.min(Number(c.cursor || 0), total || Number(c.cursor || 0))
        const pct = total > 0 ? Math.min(100, Math.round((cursor / total) * 100)) : 0
        const running = c.status === 'pending'
        const done = !!c.completedToday && cursor >= total && total > 0
        const statusLabel = running ? '运行中' : (done ? '今日已完成' : '等待中')
        const statusClass = running ? 'running' : (done ? 'done' : 'waiting')
        this.setData({
          control: c,
          failedNames: r.failedNames || [],
          failedCount: (r.failedNames || []).length,
          pct, cursor, total,
          statusLabel, statusClass,
          lastRunText: formatAgo(toMillis(c.lastTickAt)),
          autoLoaded: true,
        })
      },
      fail: () => this.setData({ autoLoaded: true }),
    })
  },

  loadReports() {
    this.setData({ loading: true, loadError: '' })
    wx.cloud.callFunction({
      name: 'manageCrawlerReports', data: { action: 'list' },
      success: (res: any) => { const r = res.result || {}; if (!r.success) { this.setData({ loading: false, loadError: r.error || '加载失败' }); return } this.setData({ list: r.list || [], loading: false }) },
      fail: () => this.setData({ loading: false, loadError: '加载失败，请确认云函数已部署' }),
    } as any)
  },

  onToggleFailed() { if (this.data.failedCount > 0) this.setData({ showFailed: !this.data.showFailed }) },

  onReset() {
    if (this.data.resetting) return
    wx.showModal({
      title: '全部重置',
      content: '将把指针清零、失败清空，今天从头重新爬取所有已批准 rapper。下一分钟内自动开始。确定？',
      confirmText: '重新爬取', confirmColor: '#2D6FE0',
      success: (m) => {
        if (!m.confirm) return
        this.setData({ resetting: true })
        wx.cloud.callFunction({
          name: 'cloudCrawlerDailyTrigger', data: { action: 'reset' },
          success: (res: any) => {
            this.setData({ resetting: false })
            const r = res.result || {}
            if (r.success) { wx.showToast({ title: '已重置，即将开始', icon: 'success' }); this.loadAuto() }
            else wx.showToast({ title: r.error || '重置失败', icon: 'none' })
          },
          fail: () => { this.setData({ resetting: false }); wx.showToast({ title: '网络错误', icon: 'none' }) },
        })
      },
    })
  },
})
