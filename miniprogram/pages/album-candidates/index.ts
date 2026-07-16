import { getThemeClass } from '../../utils/theme'

Page({
  data: {
    statusBarHeight: 20,
    themeClass: '',
    list: [] as any[],
    total: 0,
    loading: true,
    loadError: '',
    selectedIds: [] as string[],
    allSelected: false,
    processing: false,
    mode: 'pending' as 'pending' | 'hidden',
    hiddenScope: 'manual' as 'manual' | 'legacy',
  },
  onLoad(options: Record<string, string>) {
    const app = getApp<IAppOption>()
    const mode = options.mode === 'hidden' ? 'hidden' : 'pending'
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, mode })
    this.loadCandidates()
  },
  onShow() { this.setData({ themeClass: getThemeClass() }); this.loadCandidates() },
  switchMode(e: WechatMiniprogram.TouchEvent) {
    const mode = String((e.currentTarget.dataset as any).mode || '') as 'pending' | 'hidden'
    if (!mode || mode === this.data.mode || this.data.processing) return
    this.setData({ mode, list: [], total: 0, selectedIds: [], allSelected: false })
    this.loadCandidates()
  },
  switchHiddenScope(e: WechatMiniprogram.TouchEvent) {
    const hiddenScope = String((e.currentTarget.dataset as any).scope || '') as 'manual' | 'legacy'
    if (!hiddenScope || hiddenScope === this.data.hiddenScope || this.data.processing) return
    this.setData({ hiddenScope, list: [], total: 0, selectedIds: [], allSelected: false })
    this.loadCandidates()
  },
  loadCandidates() {
    this.setData({ loading: true, loadError: '' })
    const hidden = this.data.mode === 'hidden'
    const action = hidden ? (this.data.hiddenScope === 'legacy' ? 'listLegacyHidden' : 'listHidden') : 'list'
    wx.cloud.callFunction({
      name: 'manageAlbumCandidates',
      data: hidden ? { action } : { action, status: 'pending' },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ list: [], total: 0, loading: false, loadError: r.error || '加载失败，请确认云函数已部署', selectedIds: [], allSelected: false }); return }
        const list = (r.list || []).map((item: any) => ({ ...item, selected: false }))
        this.setData({ list, total: Number(r.total ?? list.length), loading: false, loadError: '', selectedIds: [], allSelected: false })
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
  _callBatchChunk(action: string, ids: string[], decision: 'keep' | 'delete' | 'mark') {
    return new Promise<any>((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'manageAlbumCandidates',
        data: { action, ids, decision },
        success: (res: any) => resolve(res.result || {}),
        fail: reject,
      } as any)
    })
  },
  batchDecide(e: WechatMiniprogram.TouchEvent) {
    const decision = String((e.currentTarget.dataset as any).decision || '') as 'keep' | 'delete' | 'mark'
    const ids = this.data.selectedIds.slice()
    if (!ids.length) { wx.showToast({ title: '请先选择专辑', icon: 'none' }); return }
    const hidden = this.data.mode === 'hidden'
    const legacy = hidden && this.data.hiddenScope === 'legacy'
    const label = decision === 'delete' ? '批量删除' : decision === 'mark' ? '纳入手动隐藏' : hidden ? '批量显示' : '批量保留'
    const content = decision === 'delete'
      ? '所选专辑及其关联数据将被删除，此操作不可撤销。'
      : decision === 'mark'
        ? '所选历史未显示专辑将标记为管理员手动隐藏，之后会出现在“手动隐藏”中。'
        : hidden ? '所选专辑将重新对用户显示。' : '所选专辑会重新进入正式专辑库。'
    wx.showModal({
      title: `${label} ${ids.length} 张专辑？`,
      content,
      confirmText: decision === 'delete' ? '全部删除' : decision === 'mark' ? '确认纳入' : hidden ? '全部显示' : '全部保留',
      confirmColor: '#C94E25',
      success: async (modal) => {
        if (!modal.confirm) return
        this.setData({ processing: true })
        const action = hidden ? 'batchDecideHidden' : 'batchDecide'
        const chunkSize = 5
        let succeeded = 0
        let failed = 0
        let networkFailed = false
        try {
          for (let i = 0; i < ids.length; i += chunkSize) {
            const chunk = ids.slice(i, i + chunkSize)
            wx.showLoading({ title: `${Math.min(i + chunk.length, ids.length)}/${ids.length} 处理中`, mask: true })
            try {
              const r = await this._callBatchChunk(action, chunk, decision)
              succeeded += Number(r.succeeded || (r.success ? chunk.length : 0))
              failed += Number(r.failed || (!r.success && !r.partial ? chunk.length : 0))
            } catch (err) {
              networkFailed = true
              failed += chunk.length
              console.error('batch chunk failed', chunk, err)
            }
          }
        } finally {
          wx.hideLoading()
          this.setData({ processing: false })
        }
        if (succeeded > 0) {
          wx.showToast({ title: failed ? `成功 ${succeeded}，失败 ${failed}` : `已处理 ${succeeded} 张`, icon: failed ? 'none' : 'success', duration: 2600 })
          this.loadCandidates()
          if (legacy && decision === 'mark') wx.showToast({ title: `已纳入 ${succeeded} 张`, icon: 'success' })
        } else wx.showToast({ title: networkFailed ? '网络错误，请稍后重试' : '批量操作失败', icon: 'none' })
      },
    })
  },
  decide(e: WechatMiniprogram.TouchEvent) {
    const { id, decision } = e.currentTarget.dataset as { id: string; decision: 'keep' | 'delete' | 'mark' }
    if (!id || this.data.processing) return
    const hidden = this.data.mode === 'hidden'
    const title = decision === 'delete' ? '删除该专辑？' : decision === 'mark' ? '纳入手动隐藏？' : hidden ? '显示该专辑？' : '保留该专辑？'
    const content = decision === 'delete'
      ? '该专辑及其关联评论、收藏将被删除，此操作不可撤销。'
      : decision === 'mark'
        ? '该专辑将标记为管理员手动隐藏。'
        : hidden ? '该专辑将重新对用户显示。' : '该专辑会重新进入正式专辑库。'
    wx.showModal({
      title,
      content,
      confirmText: decision === 'delete' ? '删除' : decision === 'mark' ? '纳入' : hidden ? '显示' : '保留',
      confirmColor: '#C94E25',
      success: (modal) => {
        if (!modal.confirm) return
        wx.showLoading({ title: decision === 'delete' ? '删除中…' : decision === 'mark' ? '处理中…' : hidden ? '显示中…' : '保留中…', mask: true })
        wx.cloud.callFunction({
          name: 'manageAlbumCandidates',
          data: { action: hidden ? 'decideHidden' : 'decide', id, decision },
          success: (res: any) => {
            wx.hideLoading()
            if (res.result?.success) { wx.showToast({ title: decision === 'delete' ? '已删除' : decision === 'mark' ? '已纳入隐藏' : hidden ? '已显示' : '已保留', icon: 'success' }); this.loadCandidates() }
            else wx.showToast({ title: res.result?.error || '操作失败', icon: 'none' })
          },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '网络错误', icon: 'none' }) },
        } as any)
      },
    })
  },
  onBack() { wx.navigateBack() },
})
