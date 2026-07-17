import { getThemeClass } from '../../utils/theme'

function formatDate(value: any): string {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    loading: true,
    loadError: '',
    interview: null as any,
    publishedAtDisplay: '',
  },

  onLoad(options: any) {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
    const id = String(options.id || '')
    if (!id) { this.setData({ loading: false, loadError: '缺少访谈 ID' }); return }
    this._load(id)
  },

  onShow() { this.setData({ themeClass: getThemeClass() }) },

  onBack() { wx.navigateBack() },

  _load(id: string) {
    this.setData({ loading: true, loadError: '' })
    wx.cloud.callFunction({
      name: 'manageInterviews',
      data: { action: 'get', id },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ loading: false, loadError: r.error || '加载失败' }); return }
        this.setData({ loading: false, interview: r.interview, publishedAtDisplay: formatDate(r.interview.publishedAt) })
      },
      fail: () => this.setData({ loading: false, loadError: '网络错误，请重试' }),
    } as any)
  },
})
