let _pollTimer: any = null

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,

    crawlerStatus:           null as any,
    crawlerTriggering:       false,
    crawlerScheduleEnabled:  false,
    crawlerScheduleInterval: 'weekly' as 'daily' | 'weekly',

    metadataSyncing: false,

    crawlerMode:        'approved' as 'approved' | 'artist' | 'album' | 'fission' | 'sync',
    crawlerParam:       '',
    crawlerProgressPct: 0,
    crawlerNeedsId:     false,
    crawlerIsCloud:     true,
    crawlerPlaceholder: '',
    crawlerDesc:        '云端一键爬取所有已批准 rapper 的全部专辑 + 单曲',
    crawlerLastLog:     '',
    crawlerTriggerTime: 0,
    crawlerBatchActive: false,
    crawlerModes: [
      { key: 'approved', label: '全部已批准', desc: '云端一键爬取所有已批准 rapper 的全部专辑 + 单曲',   needsId: false, cloud: true,  placeholder: '' },
      { key: 'artist',   label: '按艺人ID',   desc: '云端收录指定网易云艺人的全部专辑 + 单曲',         needsId: true,  cloud: true,  placeholder: '网易云艺人 ID，如 49779880' },
      { key: 'album',    label: '按专辑ID',   desc: '云端精确收录单张网易云专辑（含单曲）',            needsId: true,  cloud: true,  placeholder: '网易云专辑 ID' },
      { key: 'fission',  label: '裂变发现',   desc: '本地：从已批准艺人出发发现新合作艺人（需开电脑）', needsId: false, cloud: false, placeholder: '' },
      { key: 'sync',     label: '同步决定',   desc: '本地：将云端审核结果同步回 rappers.json（需开电脑）', needsId: false, cloud: false, placeholder: '' },
    ] as Array<{ key: string; label: string; desc: string; needsId: boolean; cloud: boolean; placeholder: string }>,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
  },
  onShow() { this._startPoll() },
  onHide() { this._stopPoll() },
  onUnload() { this._stopPoll() },
  onBack() { wx.navigateBack() },

  _startPoll(interval = 2000) {
    this._stopPoll()
    this._fetchStatus()
    _pollTimer = setInterval(() => this._fetchStatus(), interval)
  },
  _stopPoll() { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null } },
  _fetchStatus() {
    wx.cloud.callFunction({
      name: 'crawlerControl', data: { action: 'getStatus' },
      success: (res: any) => {
        const r = res.result
        if (!r?.success) return
        const s = r.status || {}, sched = s.schedule || {}, prog = s.progress || {}
        const pct = prog.totalArtists > 0 ? Math.round((prog.processedArtists / prog.totalArtists) * 100) : 0
        const log = s.log || s.logs || []
        this.setData({ crawlerStatus: s, crawlerProgressPct: pct, crawlerScheduleEnabled: !!sched.enabled, crawlerScheduleInterval: sched.interval || 'weekly', crawlerLastLog: log[0] || '' })
        if (!this.data.crawlerBatchActive && s.status !== 'running') this._startPoll(4000)
      },
    })
  },

  onCrawlerModeTap(e: WechatMiniprogram.TouchEvent) {
    const key = (e.currentTarget.dataset as { key: string }).key
    if (key === this.data.crawlerMode) return
    const m = this.data.crawlerModes.find((x) => x.key === key)
    this.setData({ crawlerMode: key as any, crawlerNeedsId: !!m?.needsId, crawlerIsCloud: !!m?.cloud, crawlerPlaceholder: m?.placeholder || '', crawlerDesc: m?.desc || '', crawlerParam: '' })
  },
  onCrawlerParamInput(e: WechatMiniprogram.Input) { this.setData({ crawlerParam: e.detail.value || '' }) },

  onCrawlerTrigger() {
    if (this.data.crawlerTriggering || this.data.crawlerBatchActive) return
    const s = this.data.crawlerStatus
    if (s && (s.status === 'running' || s.status === 'pending')) { wx.showToast({ title: '爬虫正在运行中', icon: 'none' }); return }
    const mode = this.data.crawlerMode, param = (this.data.crawlerParam || '').trim()
    if (this.data.crawlerNeedsId) {
      if (!param) { wx.showToast({ title: '请输入 ID', icon: 'none' }); return }
      if (!/^\d+$/.test(param)) { wx.showToast({ title: 'ID 必须是数字', icon: 'none' }); return }
    }
    if (this.data.crawlerIsCloud) this._triggerCloud(mode, param)
    else this._triggerLocal(mode, param)
  },

  _runApprovedBatch(cursor = 0, initialize = false) {
    wx.cloud.callFunction({
      name: 'crawlerBatch', data: { cursor, initialize },
      success: (res: any) => {
        const r = res.result || {}
        this._fetchStatus()
        if (!r.success) {
          this.setData({ crawlerTriggering: false, crawlerBatchActive: false })
          wx.showToast({ title: r.error || '批处理失败', icon: 'none' })
          return
        }
        if (r.status === 'running' && typeof r.nextCursor === 'number') {
          this.setData({ crawlerBatchActive: true, crawlerTriggering: false })
          setTimeout(() => this._runApprovedBatch(r.nextCursor, false), 400)
          return
        }
        this.setData({ crawlerTriggering: false, crawlerBatchActive: false })
      },
      fail: () => {
        this.setData({ crawlerTriggering: false, crawlerBatchActive: false })
        wx.showToast({ title: '批处理网络错误', icon: 'none' })
        this._fetchStatus()
      },
    })
  },

  _triggerCloud(mode: string, param: string) {
    if (mode === 'approved') {
      this.setData({ crawlerTriggering: true, crawlerBatchActive: true, crawlerTriggerTime: Date.now(), crawlerLastLog: '正在启动分批云端任务…' })
      this._runApprovedBatch(0, true)
      wx.showToast({ title: '已开始分批处理', icon: 'success' })
      this._startPoll(1500)
      return
    }
    const actionMap: Record<string, string> = { artist: 'artist', album: 'album' }
    this.setData({ crawlerTriggering: true })
    wx.cloud.callFunction({
      name: 'cloudCrawler', data: { action: actionMap[mode], param },
      success: (res: any) => {
        this.setData({ crawlerTriggering: false })
        const r = res.result
        if (r?.success) wx.showToast({ title: `新增 ${r.inserted || 0} 张`, icon: 'success' })
        else wx.showToast({ title: r?.error || '爬取失败', icon: 'none' })
        this._fetchStatus()
      },
      fail: () => { this.setData({ crawlerTriggering: false }); wx.showToast({ title: '网络错误', icon: 'error' }) },
    })
  },

  _triggerLocal(mode: string, param: string) {
    this.setData({ crawlerTriggering: true })
    wx.cloud.callFunction({ name: 'crawlerControl', data: { action: 'trigger', mode, param }, success: (res: any) => { this.setData({ crawlerTriggering: false }); if (res.result?.success) { wx.showToast({ title: '已触发，等待本地爬虫', icon: 'success' }); this._fetchStatus() } else wx.showToast({ title: '触发失败', icon: 'error' }) }, fail: () => { this.setData({ crawlerTriggering: false }); wx.showToast({ title: '网络错误', icon: 'error' }) } })
  },

  onCrawlerAbort() {
    const s = this.data.crawlerStatus
    if (!s || (s.status !== 'running' && s.status !== 'pending')) return
    wx.showModal({ title: '中止爬虫', content: '确定中止当前任务？已爬取的数据会保留。', confirmText: '中止', confirmColor: '#C0392B', success: (r) => { if (!r.confirm) return; wx.cloud.callFunction({ name: 'crawlerControl', data: { action: 'abort' }, success: (res: any) => { if (res.result?.success) { this.setData({ crawlerBatchActive: false }); wx.showToast({ title: '已请求中止', icon: 'none' }); this._fetchStatus() } else wx.showToast({ title: '操作失败', icon: 'error' }) }, fail: () => wx.showToast({ title: '网络错误', icon: 'error' }) }) } })
  },
  onCrawlerClearLog() { wx.cloud.callFunction({ name: 'crawlerControl', data: { action: 'clearLog' }, success: () => { this._fetchStatus(); wx.showToast({ title: '日志已清除', icon: 'success' }) } }) },
  onCleanupSingles() { wx.showModal({ title: '清除单曲', content: '将删除数据库中所有 trackCount 为 1 或 2 的条目，操作不可撤销。', confirmText: '清除', confirmColor: '#C0392B', success: (r) => { if (!r.confirm) return; wx.showLoading({ title: '清除中…', mask: true }); wx.cloud.callFunction({ name: 'manageCandidates', data: { action: 'cleanup_singles' }, success: (res: any) => { wx.hideLoading(); const result = res.result || {}; wx.showToast({ title: result.success ? `已删除 ${result.removed} 条` : result.error || '操作失败', icon: result.success ? 'success' : 'none' }) }, fail: () => { wx.hideLoading(); wx.showToast({ title: '网络错误', icon: 'error' }) } }) } }) },
  onSyncArtistMetadata() { wx.showToast({ title: '请使用原同步功能', icon: 'none' }) },
  onScheduleToggle() { wx.showToast({ title: '定时功能未改动', icon: 'none' }) },
  onScheduleInterval() { wx.showToast({ title: '定时功能未改动', icon: 'none' }) },
})
