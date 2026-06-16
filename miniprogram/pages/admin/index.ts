interface Candidate {
  _id:        string
  artistId:   number
  artistName: string
  picUrl:     string
  albumSize:  number
  fansSize:   number
  fansText:   string   // formatted, e.g. "12.3万粉"
  foundFrom:  string
  fromAlbum:  string
  round:      number
  status:     'pending' | 'approved' | 'declined'
  addedAt:    string
}

const formatFans = (n: number): string => {
  if (!n) return ''
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万粉`
  return `${n} 粉`
}

type TabKey = 'pending' | 'approved' | 'declined'

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,

    activeTab:  'pending' as TabKey,
    tabs: [
      { key: 'pending',  label: '待审核', count: 0 },
      { key: 'approved', label: '已批准', count: 0 },
      { key: 'declined', label: '已拒绝', count: 0 },
    ],

    list:    [] as Candidate[],
    loading: false,
    hasMore: false,
    page:    1,
    pageSize: 20,

    deciding:   {} as Record<string, boolean>,  // _id → true while in-flight
    refreshing: {} as Record<string, boolean>, // _id → true while re-crawling
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight:    app.globalData.topbarHeight,
    })
    this._loadStats()
    this._loadList('pending', 1)
  },

  // ── stats badge ─────────────────────────────────────────────────────────────
  _loadStats() {
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'stats' },
      success: (res: any) => {
        const r = res.result
        if (!r.success) return
        const tabs = this.data.tabs.map((t: any) => ({
          ...t,
          count: r[t.key] || 0,
        }))
        this.setData({ tabs })
      },
    })
  },

  // ── tab switch ──────────────────────────────────────────────────────────────
  onTabTap(e: WechatMiniprogram.TouchEvent) {
    const key = (e.currentTarget.dataset as { key: TabKey }).key
    if (key === this.data.activeTab) return
    this.setData({ activeTab: key, list: [], page: 1 })
    this._loadList(key, 1)
  },

  // ── load list ────────────────────────────────────────────────────────────────
  _loadList(status: TabKey, page: number) {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'list', status, page, pageSize: this.data.pageSize },
      success: (res: any) => {
        const r = res.result
        if (!r.success) { this.setData({ loading: false }); return }
        const newList = (page === 1 ? r.list : [...this.data.list, ...r.list])
          .map((item: any) => ({ ...item, fansText: formatFans(item.fansSize || 0) }))
        this.setData({
          list:    newList,
          page,
          hasMore: r.list.length === this.data.pageSize,
          loading: false,
        })
      },
      fail: () => this.setData({ loading: false }),
    })
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this._loadList(this.data.activeTab, this.data.page + 1)
  },

  onPullDownRefresh() {
    this._loadStats()
    this._loadList(this.data.activeTab, 1)
    wx.stopPullDownRefresh()
  },

  onBack() {
    wx.navigateBack()
  },

  // ── decide ───────────────────────────────────────────────────────────────────
  onApprove(e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset as { id: string }
    this._decide(id, 'approved')
  },

  onDecline(e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset as { id: string }
    this._decide(id, 'declined')
  },

  onRevoke(e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset as { id: string }
    this._decide(id, 'pending')
  },

  onRestore(e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset as { id: string }
    this._decide(id, 'pending')
  },

  _decide(docId: string, decision: 'approved' | 'declined' | 'pending') {
    const deciding = { ...this.data.deciding, [docId]: true }
    this.setData({ deciding })

    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: {
        action:    'decide',
        decisions: [{ id: docId, decision }],
      },
      success: (res: any) => {
        const r = res.result
        if (r.success) {
          const list = this.data.list.filter((c: Candidate) => c._id !== docId)
          const currentTab = this.data.activeTab
          const tabs = this.data.tabs.map((t: any) => {
            if (decision === 'pending') {
              // 撤销/恢复：当前 tab 减一，pending 加一
              if (t.key === currentTab) return { ...t, count: Math.max(0, t.count - 1) }
              if (t.key === 'pending')  return { ...t, count: t.count + 1 }
            } else {
              // 正常审核：pending 减一，目标 tab 加一
              if (t.key === 'pending')  return { ...t, count: Math.max(0, t.count - 1) }
              if (t.key === decision)   return { ...t, count: t.count + 1 }
            }
            return t
          })
          const deciding = { ...this.data.deciding }
          delete deciding[docId]
          this.setData({ list, tabs, deciding })
        } else {
          const deciding = { ...this.data.deciding }
          delete deciding[docId]
          this.setData({ deciding })
          wx.showToast({ title: '操作失败', icon: 'error' })
        }
      },
      fail: () => {
        const deciding = { ...this.data.deciding }
        delete deciding[docId]
        this.setData({ deciding })
        wx.showToast({ title: '网络错误', icon: 'error' })
      },
    })
  },

  onRefresh(e: WechatMiniprogram.TouchEvent) {
    const { id } = e.currentTarget.dataset as { id: string }
    if (this.data.refreshing[id]) return

    const refreshing = { ...this.data.refreshing, [id]: true }
    this.setData({ refreshing })

    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'refresh_albums', candidateId: id },
      success: (res: any) => {
        const r = res.result
        const refreshing = { ...this.data.refreshing }
        delete refreshing[id]
        this.setData({ refreshing })
        if (r.success) {
          wx.showToast({ title: `已新增 ${r.inserted} 张`, icon: 'success' })
        } else {
          wx.showToast({ title: '刷新失败', icon: 'error' })
        }
      },
      fail: () => {
        const refreshing = { ...this.data.refreshing }
        delete refreshing[id]
        this.setData({ refreshing })
        wx.showToast({ title: '网络错误', icon: 'error' })
      },
    })
  },
})
