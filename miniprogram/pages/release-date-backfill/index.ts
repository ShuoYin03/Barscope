Page({
  data: { statusBarHeight: 20, running: false, processed: 0, updated: 0, failed: 0, missing: 0, done: false, message: '准备就绪' },
  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight })
  },
  onBack() { wx.navigateBack() },
  onRun() {
    if (this.data.running) return
    wx.showModal({
      title: '回填发行日期',
      content: '将为 albums 中缺少 releaseDate 的专辑逐条查询网易云并写入真实发布日期。过程可能需要几分钟。',
      confirmText: '开始回填',
      confirmColor: '#C94E25',
      success: (r) => { if (r.confirm) this.runBatch(0) },
    })
  },
  runBatch(skip: number) {
    this.setData({ running: true, done: false, message: `正在处理第 ${skip + 1} 张起的数据…` })
    wx.cloud.callFunction({
      name: 'backfillReleaseDates',
      data: { skip },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ running: false, message: r.error || '回填失败' }); wx.showToast({ title: r.error || '回填失败', icon: 'none' }); return }
        const processed = this.data.processed + Number(r.processed || 0)
        const updated = this.data.updated + Number(r.updated || 0)
        const failed = this.data.failed + Number(r.failed || 0)
        const missing = this.data.missing + Number(r.missingSourceId || 0)
        this.setData({ processed, updated, failed, missing, message: r.done ? '回填完成' : `已扫描 ${processed} 张，继续处理中…` })
        if (r.done) { this.setData({ running: false, done: true }); wx.showToast({ title: `已写入 ${updated} 条日期`, icon: 'success' }); return }
        setTimeout(() => this.runBatch(Number(r.nextSkip || 0)), 300)
      },
      fail: () => { this.setData({ running: false, message: '网络或云函数错误' }); wx.showToast({ title: '调用失败', icon: 'none' }) },
    } as any)
  },
})