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
    crawlerModes: [
      { key: 'approved', label: '全部已批准', desc: '云端一键创建全量任务；之后由定时器分批续跑，避免 60 秒超时',   needsId: false, cloud: true,  placeholder: '' },
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
      name: 'crawlerControl',
      data: { action: 'getStatus' },
      success: (res: any) => {
        const r = res.result
        if (!r.success) return
        const s = r.status || {}
        const sched = s.schedule || {}
        const prog = s.progress || {}
        const pct = prog.totalArtists > 0 ? Math.round((prog.processedArtists / prog.totalArtists) * 100) : 0
        const log = s.log || s.logs || []
        const lastLog = log.length > 0 ? log[0] : ''
        const wasTriggering = this.data.crawlerTriggering
        const triggerTime = this.data.crawlerTriggerTime
        let shouldClear = false
        if (wasTriggering) {
          const elapsed = triggerTime > 0 ? Date.now() - triggerTime : 0
          if (s.status === 'running' || s.status === 'error') shouldClear = true
          else if (s.status === 'done' || s.status === 'aborted') { if (elapsed > 3000) shouldClear = true }
          else if (elapsed > 30000) { shouldClear = true; wx.showToast({ title: '启动超时，请检查云函数', icon: 'none' }) }
        }
        this.setData({
          crawlerStatus: s,
          crawlerProgressPct: pct,
          crawlerScheduleEnabled: !!sched.enabled,
          crawlerScheduleInterval: sched.interval || 'weekly',
          crawlerLastLog: lastLog,
          crawlerTriggering: wasTriggering && !shouldClear,
        })
        if (!this.data.crawlerTriggering && s.status !== 'running') this._startPoll(4000)
      },
    })
  },

  onCrawlerModeTap(e: WechatMiniprogram.TouchEvent) {
    const key = (e.currentTarget.dataset as { key: string }).key
    if (key === this.data.crawlerMode) return
    const m = this.data.crawlerModes.find((x) => x.key === key)
    this.setData({ crawlerMode:key as any, crawlerNeedsId:!!(m && m.needsId), crawlerIsCloud:!!(m && m.cloud), crawlerPlaceholder:(m && m.placeholder) || '', crawlerDesc:(m && m.desc) || '', crawlerParam:'' })
  },
  onCrawlerParamInput(e: WechatMiniprogram.Input) { this.setData({ crawlerParam: e.detail.value || '' }) },

  onCrawlerTrigger() {
    if (this.data.crawlerTriggering) return
    const s = this.data.crawlerStatus
    if (s && (s.status === 'running' || s.status === 'pending')) { wx.showToast({ title: '爬虫正在运行中', icon: 'none' }); return }
    const mode = this.data.crawlerMode
    const param = (this.data.crawlerParam || '').trim()
    if (this.data.crawlerNeedsId) {
      if (!param) { wx.showToast({ title: '请输入 ID', icon: 'none' }); return }
      if (!/^\d+$/.test(param)) { wx.showToast({ title: 'ID 必须是数字', icon: 'none' }); return }
    }
    if (this.data.crawlerIsCloud) this._triggerCloud(mode, param)
    else this._triggerLocal(mode, param)
  },

  _triggerCloud(mode: string, param: string) {
    const actionMap: Record<string, string> = { approved: 'startAllApproved', artist: 'artist', album: 'album' }
    const action = actionMap[mode]
    this.setData({ crawlerTriggering: true, crawlerTriggerTime: Date.now(), crawlerLastLog: '正在启动云端任务…' })
    wx.cloud.callFunction({
      name: 'cloudCrawler',
      data: mode === 'approved' ? { action } : { action, param },
      success: (res: any) => {
        const r = res.result || {}
        this.setData({ crawlerTriggering: false })
        if (r.success) wx.showToast({ title: mode === 'approved' ? '已创建云端任务' : `新增 ${r.inserted || 0} 张`, icon: 'success' })
        else wx.showToast({ title: r.error || '爬取失败', icon: 'none' })
        this._fetchStatus()
        if (mode === 'approved') this._startPoll(1500)
      },
      fail: (e: any) => {
        console.error('[cloudCrawler] call fail', JSON.stringify(e))
        this.setData({ crawlerTriggering: false })
        wx.showToast({ title: '启动失败', icon: 'none' })
        this._fetchStatus()
      },
    })
  },

  _triggerLocal(mode: string, param: string) {
    this.setData({ crawlerTriggering: true })
    wx.cloud.callFunction({
      name: 'crawlerControl',
      data: { action: 'trigger', mode, param },
      success: (res: any) => { this.setData({ crawlerTriggering: false }); if (res.result?.success) { wx.showToast({ title: '已触发，等待本地爬虫', icon: 'success' }); this._fetchStatus() } else wx.showToast({ title: '触发失败', icon: 'error' }) },
      fail: () => { this.setData({ crawlerTriggering: false }); wx.showToast({ title: '网络错误', icon: 'error' }) },
    })
  },

  onCrawlerAbort() {
    const s = this.data.crawlerStatus
    if (!s || (s.status !== 'running' && s.status !== 'pending')) return
    wx.showModal({ title:'中止爬虫', content:'确定中止当前任务？已爬取的数据会保留。', confirmText:'中止', confirmColor:'#C0392B', success:(r)=>{ if(!r.confirm)return; wx.cloud.callFunction({ name:'crawlerControl', data:{ action:'abort' }, success:(res:any)=>{ if(res.result&&res.result.success){ wx.showToast({ title:'已请求中止', icon:'none' }); this._fetchStatus() } else wx.showToast({ title:'操作失败', icon:'error' }) }, fail:()=>wx.showToast({ title:'网络错误', icon:'error' }) }) } })
  },

  onCrawlerClearLog() { wx.cloud.callFunction({ name:'crawlerControl', data:{ action:'clearLog' }, success:()=>{ this._fetchStatus(); wx.showToast({ title:'日志已清除', icon:'success' }) } }) },

  onCleanupSingles() {
    wx.showModal({ title:'清理专辑库', content:'将删除 trackCount 为 1 或 2 的条目，然后自动重新筛选剩余专辑，操作不可撤销。', confirmText:'开始清理', confirmColor:'#C0392B', success:(r)=>{ if(!r.confirm)return; wx.showLoading({ title:'清除单曲中…', mask:true }); wx.cloud.callFunction({ name:'manageCandidates', data:{ action:'cleanup_singles' }, success:(res:any)=>{ const result=res.result||{}; wx.hideLoading(); if(!result.success){ wx.showToast({ title:result.error||'操作失败', icon:'none' }); return } wx.showToast({ title:'已开始清理', icon:'success' }); this._fetchStatus() }, fail:()=>{ wx.hideLoading(); wx.showToast({ title:'网络错误', icon:'error' }) } }) } })
  },

  onSyncArtistMetadata() {
    if (this.data.metadataSyncing) return
    this.setData({ metadataSyncing:true })
    wx.cloud.callFunction({ name:'syncApprovedArtist', data:{ action:'allApproved' }, complete:()=>this.setData({ metadataSyncing:false }) } as any)
  },

  onScheduleToggle(e: WechatMiniprogram.SwitchChange) {
    const enabled = !!e.detail.value
    this.setData({ crawlerScheduleEnabled: enabled })
    wx.cloud.callFunction({ name:'crawlerControl', data:{ action:'updateSchedule', enabled, interval:this.data.crawlerScheduleInterval }, success:()=>wx.showToast({ title:enabled?'定时已启用':'定时已关闭', icon:'none' }) } as any)
  },
  onScheduleInterval(e: WechatMiniprogram.TouchEvent) {
    const interval = (e.currentTarget.dataset as any).v || 'weekly'
    this.setData({ crawlerScheduleInterval: interval })
    wx.cloud.callFunction({ name:'crawlerControl', data:{ action:'updateSchedule', enabled:this.data.crawlerScheduleEnabled, interval }, success:()=>wx.showToast({ title:interval==='daily'?'已设为每天':'已设为每周', icon:'none' }) } as any)
  },
})