import { getThemeClass } from '../../utils/theme'

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    list: [] as any[],
    loading: true,
    operating: '',
    expanded: {} as Record<string, boolean>,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
    this.load()
  },

  onShow() { this.setData({ themeClass: getThemeClass() }) },

  onBack() { wx.navigateBack() },

  load() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'manageInterviews',
      data: { action: 'list_pending' },
      success: (res: any) => {
        const r = res.result || {}
        this.setData({ list: r.success ? (r.list || []) : [], loading: false })
      },
      fail: () => this.setData({ loading: false }),
    } as any)
  },

  onToggleExpand(e: WechatMiniprogram.TouchEvent) {
    const id = String((e.currentTarget.dataset as any).id || '')
    if (!id) return
    this.setData({ [`expanded.${id}`]: !this.data.expanded[id] } as any)
  },

  onApprove(e: WechatMiniprogram.TouchEvent) {
    const id = String((e.currentTarget.dataset as any).id || '')
    if (!id || this.data.operating) return
    wx.showModal({
      title: '通过并发布？',
      content: '通过后会立即在人物访谈栏目公开展示。',
      confirmText: '通过',
      confirmColor: '#2D6FE0',
      success: (m) => { if (m.confirm) this._run('approve', id) },
    })
  },

  onReject(e: WechatMiniprogram.TouchEvent) {
    const id = String((e.currentTarget.dataset as any).id || '')
    if (!id || this.data.operating) return
    wx.showModal({
      title: '驳回投稿？',
      editable: true,
      placeholderText: '可填写驳回原因，投稿人可见',
      confirmText: '驳回',
      success: (m) => { if (m.confirm) this._run('reject', id, (m as any).content || '') },
    })
  },

  _run(decision: string, id: string, reviewNote = '') {
    this.setData({ operating: id })
    wx.cloud.callFunction({
      name: 'manageInterviews',
      data: { action: 'review', id, decision, reviewNote },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { wx.showToast({ title: r.error || '操作失败', icon: 'none' }); return }
        wx.showToast({ title: decision === 'approve' ? '已发布' : '已驳回', icon: 'success' })
        this.load()
      },
      fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
      complete: () => this.setData({ operating: '' }),
    } as any)
  },
})
