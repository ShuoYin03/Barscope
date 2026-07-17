interface Candidate {
  _id: string
  artistId: number
  artistName: string
  picUrl: string
  albumSize: number
  fansSize: number
  fansText: string
  foundFrom: string
  fromAlbum: string
  round: number
  status: 'pending' | 'approved' | 'declined'
  addedAt: string
}

import { getThemeClass } from '../../utils/theme'

const formatFans = (n: number): string => { if (!n) return ''; if (n >= 10000) return `${(n / 10000).toFixed(1)}万粉`; return `${n} 粉` }
type TabKey = 'pending' | 'approved' | 'declined'
let _searchTimer: any = null

Page({
  data: {
    statusBarHeight: 20, topbarHeight: 64, themeClass: '',
    activeTab: 'pending' as TabKey,
    tabs: [{ key: 'pending', label: '待审核', count: 0 }, { key: 'approved', label: '已批准', count: 0 }, { key: 'declined', label: '已拒绝', count: 0 }],
    list: [] as Candidate[], loading: false, hasMore: false, page: 1, pageSize: 20,
    deciding: {} as Record<string, boolean>, refreshing: {} as Record<string, boolean>, keyword: '',
    selectMode: false, selected: {} as Record<string, boolean>, batchDeciding: false, exporting: false,
    purging: false, purgedCount: 0,
  },
  onLoad(options: Record<string, string>) { const app = getApp<IAppOption>(); this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight }); this._loadStats(); const valid: TabKey[] = ['pending', 'approved', 'declined']; const tab = options && options.tab as TabKey; const initial: TabKey = valid.indexOf(tab) >= 0 ? tab : 'pending'; this.setData({ activeTab: initial }); this._loadList(initial, 1) },
  onShow() { this.setData({ themeClass: getThemeClass() }) },
  _loadStats() { wx.cloud.callFunction({ name: 'manageCandidates', data: { action: 'stats' }, success: (res: any) => { const r = res.result; if (!r.success) return; const tabs = this.data.tabs.map((t: any) => ({ ...t, count: r[t.key] || 0 })); this.setData({ tabs }) } }) },
  onTabTap(e: WechatMiniprogram.TouchEvent) { const key = (e.currentTarget.dataset as { key: TabKey }).key; if (key === this.data.activeTab) return; this.setData({ activeTab: key, list: [], page: 1, keyword: '', selectMode: false, selected: {} }); this._loadList(key, 1) },
  _loadList(status: TabKey, page: number) { this.setData({ loading: true }); wx.cloud.callFunction({ name: 'manageCandidates', data: { action: 'list', status, page, pageSize: this.data.pageSize, keyword: this.data.keyword }, success: (res: any) => { const r = res.result; if (!r.success) { this.setData({ loading: false }); return }; const newList = (page === 1 ? r.list : [...this.data.list, ...r.list]).map((item: any) => ({ ...item, fansText: formatFans(item.fansSize || 0) })); this.setData({ list: newList, page, hasMore: r.list.length === this.data.pageSize, loading: false }) }, fail: () => this.setData({ loading: false }) }) },
  onSearch(e: WechatMiniprogram.Input) { const keyword = e.detail.value || ''; this.setData({ keyword, list: [], page: 1 }); clearTimeout(_searchTimer); _searchTimer = setTimeout(() => this._loadList(this.data.activeTab, 1), 400) },
  onClearSearch() { this.setData({ keyword: '', list: [], page: 1 }); this._loadList(this.data.activeTab, 1) },
  onReachBottom() { if (!this.data.hasMore || this.data.loading) return; this._loadList(this.data.activeTab, this.data.page + 1) },
  onPullDownRefresh() { this._loadStats(); this.setData({ list: [], page: 1 }); this._loadList(this.data.activeTab, 1); wx.stopPullDownRefresh() },
  onBack() { wx.navigateBack() },
  onOpenEditorialTemplates() { wx.navigateTo({ url: '/pages/editorial-templates/index' }) },
  onCopyApprovedList() {
    if (this.data.exporting) return
    this.setData({ exporting: true })
    wx.showLoading({ title: '正在生成名单…', mask: true })
    wx.cloud.callFunction({
      name: 'exportApprovedRappers',
      data: {},
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success || !r.text) throw new Error(r.error || 'empty result')
        wx.setClipboardData({
          data: r.text,
          success: () => wx.showToast({ title: `已复制 ${r.count} 位`, icon: 'success', duration: 2200 }),
          fail: () => wx.showModal({ title: '复制失败', content: '系统未能写入剪贴板，请重试。', showCancel: false }),
          complete: () => { wx.hideLoading(); this.setData({ exporting: false }) },
        })
      },
      fail: () => { wx.hideLoading(); this.setData({ exporting: false }); wx.showModal({ title: '导出失败', content: '云端名单读取失败，请检查云函数是否已部署。', showCancel: false }) },
    })
  },
  onApprove(e: WechatMiniprogram.TouchEvent) { const { id } = e.currentTarget.dataset as { id: string }; this._decide([{ id, decision: 'approved' }]) },
  onDecline(e: WechatMiniprogram.TouchEvent) { const { id } = e.currentTarget.dataset as { id: string }; this._decide([{ id, decision: 'declined' }]) },
  onRevoke(e: WechatMiniprogram.TouchEvent) { const { id } = e.currentTarget.dataset as { id: string }; this._decide([{ id, decision: 'pending' }]) },
  onRestore(e: WechatMiniprogram.TouchEvent) { const { id } = e.currentTarget.dataset as { id: string }; this._decide([{ id, decision: 'pending' }]) },
  _decide(decisions: Array<{ id: string; decision: string }>) { const ids = decisions.map(d => d.id); const decidingPatch: Record<string, boolean> = {}; ids.forEach(id => { decidingPatch[id] = true }); this.setData({ deciding: { ...this.data.deciding, ...decidingPatch } }); wx.cloud.callFunction({ name: 'manageCandidates', data: { action: 'decide', decisions }, success: (res: any) => { const r = res.result, deciding = { ...this.data.deciding }; ids.forEach(id => delete deciding[id]); if (r.success) { const idsSet = new Set(ids), list = this.data.list.filter((c: Candidate) => !idsSet.has(c._id)); this.setData({ list, deciding }); this._loadStats() } else { this.setData({ deciding }); wx.showToast({ title: '操作失败', icon: 'error' }) } }, fail: () => { const deciding = { ...this.data.deciding }; ids.forEach(id => delete deciding[id]); this.setData({ deciding }); wx.showToast({ title: '网络错误', icon: 'error' }) } }) },
  onRefresh(e: WechatMiniprogram.TouchEvent) { const { id } = e.currentTarget.dataset as { id: string }; if (this.data.refreshing[id]) return; this.setData({ refreshing: { ...this.data.refreshing, [id]: true } }); wx.cloud.callFunction({ name: 'manageCandidates', data: { action: 'refresh_albums', candidateId: id }, success: (res: any) => { const r = res.result, refreshing = { ...this.data.refreshing }; delete refreshing[id]; this.setData({ refreshing }); if (r.success) { const title = r.fetched === 0 ? '拉取0张·可能被风控' : r.inserted > 0 ? `新增 ${r.inserted} 张` : `已是最新·拉取${r.fetched}`; wx.showToast({ title, icon: 'none' }) } else wx.showToast({ title: '刷新失败', icon: 'error' }) }, fail: () => { const refreshing = { ...this.data.refreshing }; delete refreshing[id]; this.setData({ refreshing }); wx.showToast({ title: '网络错误', icon: 'error' }) } }) },
  onToggleSelectMode() { const selectMode = !this.data.selectMode; this.setData({ selectMode, selected: {} }) },
  onCardTap(e: WechatMiniprogram.TouchEvent) { if (!this.data.selectMode) return; const { id } = e.currentTarget.dataset as { id: string }; const selected = { ...this.data.selected }; if (selected[id]) delete selected[id]; else selected[id] = true; this.setData({ selected }) },
  onSelectAll() { const selected: Record<string, boolean> = {}; this.data.list.forEach((c: Candidate) => { selected[c._id] = true }); this.setData({ selected }) },
  onDeselectAll() { this.setData({ selected: {} }) },
  onBatchApprove() { this._batchDecide('approved') }, onBatchDecline() { this._batchDecide('declined') }, onBatchRestore() { this._batchDecide('pending') },
  _batchDecide(decision: string) { const ids = Object.keys(this.data.selected); if (!ids.length || this.data.batchDeciding) return; this.setData({ batchDeciding: true }); const decisions = ids.map(id => ({ id, decision })); wx.cloud.callFunction({ name: 'manageCandidates', data: { action: 'decide', decisions }, success: (res: any) => { const r = res.result; if (r.success) { const idsSet = new Set(ids), list = this.data.list.filter((c: Candidate) => !idsSet.has(c._id)); this.setData({ list, selected: {}, selectMode: false, batchDeciding: false }); this._loadStats(); wx.showToast({ title: `已处理 ${ids.length} 位`, icon: 'success' }) } else { this.setData({ batchDeciding: false }); wx.showToast({ title: '操作失败', icon: 'error' }) } }, fail: () => { this.setData({ batchDeciding: false }); wx.showToast({ title: '网络错误', icon: 'error' }) } }) },
  onPurgeDeclined() {
    if (this.data.purging) return
    const declinedTab = this.data.tabs.find((t: any) => t.key === 'declined')
    wx.showModal({
      title: '清空已拒绝名单？',
      content: `将永久删除全部 ${declinedTab ? declinedTab.count : 0} 条已拒绝记录，不可恢复。这些艺人的名字会被记入屏蔽名单，之后扫描到同名合作也不会再重新出现在待审核里。`,
      confirmText: '确认清空',
      confirmColor: '#C94E25',
      success: (m) => {
        if (!m.confirm) return
        this.setData({ purging: true, purgedCount: 0 })
        this._runPurgeStep()
      },
    })
  },
  _runPurgeStep() {
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'purge_declined' },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ purging: false }); wx.showToast({ title: r.error || '清库失败', icon: 'none' }); return }
        const purgedCount = this.data.purgedCount + (r.deleted || 0)
        this.setData({ purgedCount })
        if (r.done) {
          this.setData({ purging: false })
          this._loadStats()
          if (this.data.activeTab === 'declined') { this.setData({ list: [], page: 1 }); this._loadList('declined', 1) }
          wx.showToast({ title: `已清空 ${purgedCount} 条`, icon: 'success' })
          return
        }
        this._runPurgeStep()
      },
      fail: () => { this.setData({ purging: false }); wx.showToast({ title: '网络错误', icon: 'none' }) },
    } as any)
  },
})