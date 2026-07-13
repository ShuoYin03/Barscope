Page({
  data: {
    statusBarHeight: 20,
    list: [] as any[],
    loading: true,
    loadError: '',
    selectedIds: [] as string[],
    allSelected: false,
    processing: false,
    mode: 'pending' as 'pending' | 'hidden',
  },
  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight })
    this.loadCandidates()
  },
  onShow() { this.loadCandidates() },
  switchMode(e: WechatMiniprogram.TouchEvent) {
    const mode = String((e.currentTarget.dataset as any).mode || '') as 'pending' | 'hidden'
    if (!mode || mode === this.data.mode || this.data.processing) return
    this.setData({ mode, list: [], selectedIds: [], allSelected: false })
    this.loadCandidates()
  },
  loadCandidates() {
    this.setData({ loading: true, loadError: '' })
    const hidden = this.data.mode === 'hidden'
    wx.cloud.callFunction({
      name: 'manageAlbumCandidates',
      data: hidden ? { action: 'listHidden' } : { action: 'list', status: 'pending' },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ list: [], loading: false, loadError: r.error || '加载失败，请确认云函数已部署', selectedIds: [], allSelected: false }); return }
        const list = (r.list || []).map((item: any) => ({ ...item, selected: false }))
        this.setData({ list, loading: false, loadError: '', selectedIds: [], allSelected: false })
      },
      fail: () => { this.setData({ loading: false, loadError: '加载失败，请确认 manageAlbumCandidates 云函数已部署' }); wx.showToast({ title: '加载失败', icon: 'none' }) },
    } as any)
  },
  toggleSelect(e: WechatMiniprogram.TouchEvent) {
    const id = String((e.currentTarget.dataset as any).id || '')
    if (!id || this.data.processing) return
    const selectedIds = this.data.selectedIds.slice()
    const index = selectedIds.indexOf(id)
    if (index >= 0) selectedIds.splice(index, 1)
    else selectedIds.push(id)
    const selectedSet = new Set(selectedIds)
    const list = this.data.list.map(item => ({ ...item, selected: selectedSet.has(String(item._id)) }))
    this.setData({ list, selectedIds, allSelected: list.length > 0 && selectedIds.length === list.length })
  },
  toggleSelectAll() {
    if (this.data.processing || !this.data.list.length) return
    const allSelected = !this.data.allSelected
    const selectedIds = allSelected ? this.data.list.map(item => String(item._id)) : []
    const list = this.data.list.map(item => ({ ...item, selected: allSelected }))
    this.setData({ list, selectedIds, allSelected })
  },
  batchDecide(e: WechatMiniprogram.TouchEvent) {
    const decision = String((e.currentTarget.dataset as any).decision || '') as 'keep' | 'delete'
    const ids = this.data.selectedIds.slice()
    if (!ids.length) { wx.showToast({ title: '请先选择专辑', icon: 'none' }); return }
    const isKeep = decision === 'keep'
    const hidden = this.data.mode === 'hidden'
    wx.showModal({
      title: `${isKeep ? (hidden ? '批量显示' : '批量保留') : '批量删除'} ${ids.length} 张专辑？`,
      content: isKeep ? (hidden ? '所选专辑将重新对用户显示。' : '所选专辑会重新进入正式专辑库。') : '所选专辑及其关联数据将被删除，此操作不可撤销。',
      confirmText: isKeep ? (hidden ? '全部显示' : '全部保留') : '全部删除',
      confirmColor: '#C94E25',
      success: (modal) => {
        if (!modal.confirm) return
        this.setData({ processing: true })
        wx.showLoading({ title: isKeep ? (hidden ? '批量显示中…' : '批量保留中…') : '批量删除中…', mask: true })
        wx.cloud.callFunction({
          name: 'manageAlbumCandidates',
          data: { action: hidden ? 'batchDecideHidden' : 'batchDecide', ids, decision },
          success: (res: any) => {
            wx.hideLoading()
            this.setData({ processing: false })
            const r = res.result || {}
            if (r.success || r.partial) {
              const failed = Number(r.failed || 0)
              wx.showToast({ title: failed ? `完成，${failed} 张失败` : `已处理 ${Number(r.succeeded || ids.length)} 张`, icon: failed ? 'none' : 'success', duration: 2200 })
              this.loadCandidates()
            } else wx.showToast({ title: r.error || '批量操作失败', icon: 'none' })
          },
          fail: () => { wx.hideLoading(); this.setData({ processing: false }); wx.showToast({ title: '网络错误', icon: 'none' }) },
        } as any)
      },
    })
  },
  decide(e: WechatMiniprogram.TouchEvent) {
    const { id, decision } = e.currentTarget.dataset as { id: string; decision: 'keep' | 'delete' }
    if (!id || this.data.processing) return
    const hidden = this.data.mode === 'hidden'
    wx.showModal({
      title: decision === 'keep' ? (hidden ? '显示该专辑？' : '保留该专辑？') : '删除该专辑？',
      content: decision === 'keep' ? (hidden ? '该专辑将重新对用户显示。' : '该专辑会重新进入正式专辑库。') : '该专辑及其关联评论、收藏将被删除，此操作不可撤销。',
      confirmText: decision === 'keep' ? (hidden ? '显示' : '保留') : '删除',
      confirmColor: '#C94E25',
      success: (modal) => {
        if (!modal.confirm) return
        wx.showLoading({ title: decision === 'keep' ? (hidden ? '显示中…' : '保留中…') : '删除中…', mask: true })
        wx.cloud.callFunction({
          name: 'manageAlbumCandidates',
          data: { action: hidden ? 'decideHidden' : 'decide', id, decision },
          success: (res: any) => {
            wx.hideLoading()
            if (res.result?.success) { wx.showToast({ title: decision === 'keep' ? (hidden ? '已显示' : '已保留') : '已删除', icon: 'success' }); this.loadCandidates() }
            else wx.showToast({ title: res.result?.error || '操作失败', icon: 'none' })
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '网络错误', icon: 'none' }) },
        } as any)
      },
    })
  },
  onBack() { wx.navigateBack() },
})
