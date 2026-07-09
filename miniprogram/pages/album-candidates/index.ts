Page({
  data: {
    statusBarHeight: 20,
    list: [] as any[],
    loading: true,
    loadError: '',
  },
  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight })
    this.loadCandidates()
  },
  onShow() { this.loadCandidates() },
  loadCandidates() {
    this.setData({ loading: true, loadError: '' })
    wx.cloud.callFunction({
      name: 'manageAlbumCandidates',
      data: { action: 'list', status: 'pending' },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ list: [], loading: false, loadError: r.error || '加载失败，请确认云函数已部署' }); return }
        this.setData({ list: r.list || [], loading: false, loadError: '' })
      },
      fail: () => { this.setData({ loading: false, loadError: '加载失败，请确认 manageAlbumCandidates 云函数已部署' }); wx.showToast({ title: '加载失败', icon: 'none' }) },
    } as any)
  },
  decide(e: WechatMiniprogram.TouchEvent) {
    const { id, decision } = e.currentTarget.dataset as { id: string; decision: 'keep' | 'delete' }
    if (!id) return
    wx.showModal({
      title: decision === 'keep' ? '保留该专辑？' : '删除该专辑？',
      content: decision === 'keep' ? '该专辑会重新进入正式专辑库。' : '该专辑会从正式专辑库移除，并从待处理列表关闭。',
      confirmText: decision === 'keep' ? '保留' : '删除',
      confirmColor: '#C94E25',
      success: (modal) => {
        if (!modal.confirm) return
        wx.showLoading({ title: decision === 'keep' ? '保留中…' : '删除中…', mask: true })
        wx.cloud.callFunction({
          name: 'manageAlbumCandidates',
          data: { action: 'decide', id, decision },
          success: (res: any) => {
            wx.hideLoading()
            if (res.result?.success) { wx.showToast({ title: decision === 'keep' ? '已保留' : '已删除', icon: 'success' }); this.loadCandidates() }
            else wx.showToast({ title: res.result?.error || '操作失败', icon: 'none' })
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '网络错误', icon: 'none' }) },
        } as any)
      },
    })
  },
  onBack() { wx.navigateBack() },
})