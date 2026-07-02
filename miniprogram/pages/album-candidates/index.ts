Page({
  data: {
    statusBarHeight: 20,
    list: [] as any[],
    loading: true,
  },
  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight })
    this.loadCandidates()
  },
  onShow() { this.loadCandidates() },
  loadCandidates() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'manageAlbumCandidates',
      data: { action: 'list', status: 'pending' },
      success: (res: any) => this.setData({ list: res.result?.list || [], loading: false }),
      fail: () => { this.setData({ loading: false }); wx.showToast({ title: '加载失败', icon: 'none' }) },
    } as any)
  },
  decide(e: WechatMiniprogram.TouchEvent) {
    const { id, decision } = e.currentTarget.dataset as { id: string; decision: 'approve' | 'decline' }
    if (!id) return
    wx.showLoading({ title: decision === 'approve' ? '收录中…' : '拒绝中…', mask: true })
    wx.cloud.callFunction({
      name: 'manageAlbumCandidates',
      data: { action: 'decide', id, decision },
      success: (res: any) => {
        wx.hideLoading()
        if (res.result?.success) { wx.showToast({ title: decision === 'approve' ? '已收录' : '已拒绝', icon: 'success' }); this.loadCandidates() }
        else wx.showToast({ title: res.result?.error || '操作失败', icon: 'none' })
      },
      fail: () => { wx.hideLoading(); wx.showToast({ title: '网络错误', icon: 'none' }) },
    } as any)
  },
  onBack() { wx.navigateBack() },
})
