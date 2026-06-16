interface Candidate {
  _id:        string
  artistId:   number
  artistName: string
  picUrl:     string
  albumSize:  number
  fansSize:   number
  fansText:   string
  foundFrom:  string
  fromAlbum:  string
  round:      number
  status:     'pending' | 'approved' | 'declined'
  addedAt:    string
}

interface CriticUser {
  openId:      string
  nickName:    string
  avatarUrl:   string
  type:        'critic' | 'normal' | 'admin'
  reviewCount: number
  joinedAt:    string
}

const formatFans = (n: number): string => {
  if (!n) return ''
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万粉`
  return `${n} 粉`
}

type TabKey = 'pending' | 'approved' | 'declined' | 'critics' | 'crawler'

let _criticSearchTimer: any = null
let _crawlerPollTimer:  any = null

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,

    activeTab:  'pending' as TabKey,
    tabs: [
      { key: 'pending',  label: '待审核', count: 0 },
      { key: 'approved', label: '已批准', count: 0 },
      { key: 'declined', label: '已拒绝', count: 0 },
      { key: 'critics',  label: '乐评人', count: 0 },
      { key: 'crawler',  label: '爬虫',   count: 0 },
    ],

    // Candidate tabs state
    list:    [] as Candidate[],
    loading: false,
    hasMore: false,
    page:    1,
    pageSize: 20,
    deciding:   {} as Record<string, boolean>,
    refreshing: {} as Record<string, boolean>,

    // Critics tab state
    criticList:     [] as CriticUser[],
    criticKeyword:  '',
    criticLoading:  false,
    criticHasMore:  false,
    criticPage:     1,
    operating:      {} as Record<string, boolean>,

    // Crawler tab state
    crawlerStatus: null as any,
    crawlerTriggering: false,
    crawlerScheduleEnabled: false,
    crawlerScheduleInterval: 'weekly' as 'daily' | 'weekly',
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
          count: t.key === 'critics' ? 0 : (r[t.key] || 0),
        }))
        this.setData({ tabs })
      },
    })
  },

  // ── tab switch ──────────────────────────────────────────────────────────────
  onTabTap(e: WechatMiniprogram.TouchEvent) {
    const key = (e.currentTarget.dataset as { key: TabKey }).key
    if (key === this.data.activeTab) return
    this.setData({ activeTab: key })

    if (key === 'critics') {
      this.setData({ criticList: [], criticPage: 1 })
      this._loadCritics('', 1)
    } else if (key === 'crawler') {
      this._startCrawlerPoll()
    } else {
      this._stopCrawlerPoll()
      this.setData({ list: [], page: 1 })
      this._loadList(key as any, 1)
    }
  },

  // ── candidate list ──────────────────────────────────────────────────────────
  _loadList(status: 'pending' | 'approved' | 'declined', page: number) {
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
    if (this.data.activeTab === 'critics') {
      if (!this.data.criticHasMore || this.data.criticLoading) return
      this._loadCritics(this.data.criticKeyword, this.data.criticPage + 1)
    } else {
      if (!this.data.hasMore || this.data.loading) return
      this._loadList(this.data.activeTab as any, this.data.page + 1)
    }
  },

  onPullDownRefresh() {
    if (this.data.activeTab === 'critics') {
      this._loadCritics(this.data.criticKeyword, 1)
    } else {
      this._loadStats()
      this._loadList(this.data.activeTab as any, 1)
    }
    wx.stopPullDownRefresh()
  },

  onBack() {
    wx.navigateBack()
  },

  // ── candidate actions ────────────────────────────────────────────────────────
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
            if (t.key === 'critics') return t
            if (decision === 'pending') {
              if (t.key === currentTab) return { ...t, count: Math.max(0, t.count - 1) }
              if (t.key === 'pending')  return { ...t, count: t.count + 1 }
            } else {
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

  // ── critics tab ──────────────────────────────────────────────────────────────
  _loadCritics(keyword: string, page: number) {
    this.setData({ criticLoading: true })
    wx.cloud.callFunction({
      name: 'manageUsers',
      data: { action: 'listUsers', keyword, page, pageSize: this.data.pageSize },
      success: (res: any) => {
        const r = res.result
        if (!r.success) { this.setData({ criticLoading: false }); return }
        const newList = page === 1 ? r.list : [...this.data.criticList, ...r.list]
        this.setData({
          criticList:    newList,
          criticPage:    page,
          criticHasMore: r.list.length === this.data.pageSize,
          criticLoading: false,
        })
      },
      fail: () => this.setData({ criticLoading: false }),
    })
  },

  onCriticKeyword(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value || ''
    this.setData({ criticKeyword: keyword, criticList: [], criticPage: 1 })
    clearTimeout(_criticSearchTimer)
    _criticSearchTimer = setTimeout(() => {
      this._loadCritics(keyword, 1)
    }, 500)
  },

  onGrantCritic(e: WechatMiniprogram.TouchEvent) {
    const { openid } = e.currentTarget.dataset as { openid: string }
    this._toggleCritic(openid, 'grantCritic', 'critic')
  },

  onRevokeCritic(e: WechatMiniprogram.TouchEvent) {
    const { openid } = e.currentTarget.dataset as { openid: string }
    this._toggleCritic(openid, 'revokeCritic', 'normal')
  },

  _toggleCritic(openId: string, action: string, newType: 'critic' | 'normal') {
    if (this.data.operating[openId]) return
    const operating = { ...this.data.operating, [openId]: true }
    this.setData({ operating })

    wx.cloud.callFunction({
      name: 'manageUsers',
      data: { action, openId },
      success: (res: any) => {
        const r = res.result
        const operating = { ...this.data.operating }
        delete operating[openId]
        if (r.success) {
          const criticList = this.data.criticList.map((u: CriticUser) =>
            u.openId === openId ? { ...u, type: newType } : u
          )
          this.setData({ criticList, operating })
          wx.showToast({ title: newType === 'critic' ? '已认证' : '已撤销', icon: 'success' })
        } else {
          this.setData({ operating })
          wx.showToast({ title: '操作失败', icon: 'error' })
        }
      },
      fail: () => {
        const operating = { ...this.data.operating }
        delete operating[openId]
        this.setData({ operating })
        wx.showToast({ title: '网络错误', icon: 'error' })
      },
    })
  },

  onUnload() {
    this._stopCrawlerPoll()
    clearTimeout(_criticSearchTimer)
  },

  // ── crawler tab ──────────────────────────────────────────────────────────────
  _startCrawlerPoll() {
    this._fetchCrawlerStatus()
    _crawlerPollTimer = setInterval(() => {
      if (this.data.activeTab === 'crawler') {
        this._fetchCrawlerStatus()
      } else {
        this._stopCrawlerPoll()
      }
    }, 3000)
  },

  _stopCrawlerPoll() {
    if (_crawlerPollTimer) {
      clearInterval(_crawlerPollTimer)
      _crawlerPollTimer = null
    }
  },

  _fetchCrawlerStatus() {
    wx.cloud.callFunction({
      name: 'crawlerControl',
      data: { action: 'getStatus' },
      success: (res: any) => {
        const r = res.result
        if (!r.success) return
        const s = r.status || {}
        const sched = s.schedule || {}
        this.setData({
          crawlerStatus:           s,
          crawlerScheduleEnabled:  !!sched.enabled,
          crawlerScheduleInterval: sched.interval || 'weekly',
        })
      },
    })
  },

  onCrawlerTrigger() {
    if (this.data.crawlerTriggering) return
    const s = this.data.crawlerStatus
    if (s && (s.status === 'running' || s.status === 'pending')) {
      wx.showToast({ title: '爬虫正在运行中', icon: 'none' })
      return
    }
    this.setData({ crawlerTriggering: true })
    wx.cloud.callFunction({
      name: 'crawlerControl',
      data: { action: 'trigger' },
      success: (res: any) => {
        this.setData({ crawlerTriggering: false })
        if (res.result?.success) {
          wx.showToast({ title: '已触发，请等待', icon: 'success' })
          this._fetchCrawlerStatus()
        } else {
          wx.showToast({ title: '触发失败', icon: 'error' })
        }
      },
      fail: () => {
        this.setData({ crawlerTriggering: false })
        wx.showToast({ title: '网络错误', icon: 'error' })
      },
    })
  },

  onCrawlerClearLog() {
    wx.cloud.callFunction({
      name: 'crawlerControl',
      data: { action: 'clearLog' },
      success: () => {
        this._fetchCrawlerStatus()
        wx.showToast({ title: '日志已清除', icon: 'success' })
      },
    })
  },

  onScheduleToggle(e: WechatMiniprogram.SwitchChange) {
    const enabled = e.detail.value
    this.setData({ crawlerScheduleEnabled: enabled })
    wx.cloud.callFunction({
      name: 'crawlerControl',
      data: {
        action:   'updateSchedule',
        enabled,
        interval: this.data.crawlerScheduleInterval,
      },
    })
  },

  onScheduleInterval(e: WechatMiniprogram.TouchEvent) {
    const interval = (e.currentTarget.dataset as { v: string }).v as 'daily' | 'weekly'
    this.setData({ crawlerScheduleInterval: interval })
    wx.cloud.callFunction({
      name: 'crawlerControl',
      data: {
        action:   'updateSchedule',
        enabled:  this.data.crawlerScheduleEnabled,
        interval,
      },
    })
  },
})
