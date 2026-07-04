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
      { key: 'approved', label: '全部已批准', desc: '云端一键爬取所有已批准 rapper 的全部专辑 + 单曲',   needsId: false, cloud: true,  placeholder: '' },
      { key: 'artist',   label: '按艺人ID',   desc: '云端收录指定网易云艺人的全部专辑 + 单曲',         needsId: true,  cloud: true,  placeholder: '网易云艺人 ID，如 49779880' },
      { key: 'album',    label: '按专辑ID',   desc: '云端精确收录单张网易云专辑（含单曲）',            needsId: true,  cloud: true,  placeholder: '网易云专辑 ID' },
      { key: 'fission',  label: '裂变发现',   desc: '本地：从已批准艺人出发发现新合作艺人（需开电脑）', needsId: false, cloud: false, placeholder: '' },
      { key: 'sync',     label: '同步决定',   desc: '本地：将云端审核结果同步回 rappers.json（需开电脑）', needsId: false, cloud: false, placeholder: '' },
    ] as Array<{ key: string; label: string; desc: string; needsId: boolean; cloud: boolean; placeholder: string }>,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight:    app.globalData.topbarHeight,
    })
  },

  onShow() {
    this._startPoll()
  },

  onHide() {
    this._stopPoll()
  },

  onUnload() {
    this._stopPoll()
  },

  onBack() { wx.navigateBack() },

  _startPoll(interval = 2000) {
    this._stopPoll()
    this._fetchStatus()
    _pollTimer = setInterval(() => this._fetchStatus(), interval)
  },

  _stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
  },

  _fetchStatus() {
    wx.cloud.callFunction({
      name: 'crawlerControl',
      data: { action: 'getStatus' },
      success: (res: any) => {
        const r = res.result
        if (!r.success) return
        const s       = r.status || {}
        const sched   = s.schedule || {}
        const prog    = s.progress || {}
        const pct     = prog.totalArtists > 0
          ? Math.round((prog.processedArtists / prog.totalArtists) * 100) : 0
        const log     = s.log || []
        const lastLog = log.length > 0 ? log[log.length - 1] : ''

        const wasTriggering = this.data.crawlerTriggering
        const triggerTime   = this.data.crawlerTriggerTime

        // Only clear crawlerTriggering when we can confirm the new run is active:
        //   • status=running  → cloudCrawler confirmed started
        //   • status=error    → cloudCrawler failed (also stop waiting)
        //   • 90s timeout     → something went wrong, give up
        // Do NOT clear on done/aborted alone — those might be from the PREVIOUS run
        // before the new cloudCrawler invocation has had a chance to write its status.
        let shouldClear = false
        if (wasTriggering) {
          const elapsed = triggerTime > 0 ? Date.now() - triggerTime : 0
          if (s.status === 'running' || s.status === 'error') {
            shouldClear = true
          } else if (s.status === 'done' || s.status === 'aborted') {
            // Fast run: completed before first poll. Safe to clear if >3s since trigger
            // (avoids clearing on stale 'done' from a previous run)
            if (elapsed > 3000) shouldClear = true
          } else if (elapsed > 90000) {
            shouldClear = true
            wx.showToast({ title: '启动超时，请检查云函数', icon: 'none' })
          }
        }

        this.setData({
          crawlerStatus:           s,
          crawlerProgressPct:      pct,
          crawlerScheduleEnabled:  !!sched.enabled,
          crawlerScheduleInterval: sched.interval || 'weekly',
          crawlerLastLog:          lastLog,
          crawlerTriggering:       wasTriggering && !shouldClear,
        })

        // slow down poll once stable
        if (!this.data.crawlerTriggering && s.status !== 'running') {
          this._startPoll(4000)
        }
      },
    })
  },

  onCrawlerModeTap(e: WechatMiniprogram.TouchEvent) {
    const key = (e.currentTarget.dataset as { key: string }).key
    if (key === this.data.crawlerMode) return
    const m = this.data.crawlerModes.find((x) => x.key === key)
    this.setData({
      crawlerMode:        key as any,
      crawlerNeedsId:     !!(m && m.needsId),
      crawlerIsCloud:     !!(m && m.cloud),
      crawlerPlaceholder: (m && m.placeholder) || '',
      crawlerDesc:        (m && m.desc) || '',
      crawlerParam:       '',
    })
  },

  onCrawlerParamInput(e: WechatMiniprogram.Input) {
    this.setData({ crawlerParam: e.detail.value || '' })
  },

  onCrawlerTrigger() {
    if (this.data.crawlerTriggering) return
    const s = this.data.crawlerStatus
    if (s && (s.status === 'running' || s.status === 'pending')) {
      wx.showToast({ title: '爬虫正在运行中', icon: 'none' })
      return
    }

    const mode  = this.data.crawlerMode
    const param = (this.data.crawlerParam || '').trim()
    if (this.data.crawlerNeedsId) {
      if (!param) { wx.showToast({ title: '请输入 ID', icon: 'none' }); return }
      if (!/^\d+$/.test(param)) { wx.showToast({ title: 'ID 必须是数字', icon: 'none' }); return }
    }

    if (this.data.crawlerIsCloud) this._triggerCloud(mode, param)
    else this._triggerLocal(mode, param)
  },

  _triggerCloud(mode: string, param: string) {
    const actionMap: Record<string, string> = { approved: 'allApproved', artist: 'artist', album: 'album' }
    const action = actionMap[mode]

    if (mode === 'approved') {
      this.setData({ crawlerTriggering: true, crawlerTriggerTime: Date.now(), crawlerLastLog: '正在启动云端任务…' })
      wx.cloud.callFunction({
        name: 'cloudCrawler',
        data: { action },
        success: (r: any) => {
          const result = r.result || {}
          console.log('[cloudCrawler] call success', JSON.stringify(result))
          // If function already completed (fast run), clear triggering immediately
          if (result.status === 'done' || result.status === 'error' || result.status === 'aborted') {
            this.setData({ crawlerTriggering: false })
          }
          this._fetchStatus()
        },
        fail: (e: any) => {
          console.error('[cloudCrawler] call fail', JSON.stringify(e))
          this.setData({ crawlerTriggering: false })
          wx.showToast({ title: '启动失败', icon: 'none' })
        },
      })
      wx.showToast({ title: '已在云端开始', icon: 'success' })
      this._startPoll(1500)
      return
    }

    this.setData({ crawlerTriggering: true })
    wx.cloud.callFunction({
      name: 'cloudCrawler',
      data: { action, param },
      success: (res: any) => {
        this.setData({ crawlerTriggering: false })
        const r = res.result
        if (r && r.success) wx.showToast({ title: `新增 ${r.inserted || 0} 张`, icon: 'success' })
        else wx.showToast({ title: (r && r.error) || '爬取失败', icon: 'none' })
        this._fetchStatus()
      },
      fail: () => {
        this.setData({ crawlerTriggering: false })
        wx.showToast({ title: '网络错误', icon: 'error' })
      },
    })
  },

  _triggerLocal(mode: string, param: string) {
    this.setData({ crawlerTriggering: true })
    wx.cloud.callFunction({
      name: 'crawlerControl',
      data: { action: 'trigger', mode, param },
      success: (res: any) => {
        this.setData({ crawlerTriggering: false })
        if (res.result?.success) {
          wx.showToast({ title: '已触发，等待本地爬虫', icon: 'success' })
          this._fetchStatus()
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

  onCrawlerAbort() {
    const s = this.data.crawlerStatus
    if (!s || (s.status !== 'running' && s.status !== 'pending')) return
    wx.showModal({
      title: '中止爬虫',
      content: '确定中止当前任务？已爬取的数据会保留。',
      confirmText: '中止',
      confirmColor: '#C0392B',
      success: (r) => {
        if (!r.confirm) return
        wx.cloud.callFunction({
          name: 'crawlerControl',
          data: { action: 'abort' },
          success: (res: any) => {
            if (res.result && res.result.success) {
              wx.showToast({ title: '已请求中止', icon: 'none' })
              this._fetchStatus()
            } else {
              wx.showToast({ title: '操作失败', icon: 'error' })
            }
          },
          fail: () => wx.showToast({ title: '网络错误', icon: 'error' }),
        })
      },
    })
  },

  onCrawlerClearLog() {
    wx.cloud.callFunction({
      name: 'crawlerControl',
      data: { action: 'clearLog' },
      success: () => {
        this._fetchStatus()
        wx.showToast({ title: '日志已清除', icon: 'success' })
      },
    })
  },

  onCleanupSingles() {
    wx.showModal({
      title: '清理专辑库',
      content: '将删除 trackCount 为 1 或 2 的条目，然后自动重新筛选剩余专辑（含伴奏/重复曲目版本的会移入候选区），操作不可撤销。',
      confirmText: '开始清理',
      confirmColor: '#C0392B',
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '清除单曲中…', mask: true })
        wx.cloud.callFunction({
          name: 'manageCandidates',
          data: { action: 'cleanup_singles' },
          success: (res: any) => {
            const result = res.result || {}
            if (!result.success) {
              wx.hideLoading()
              wx.showToast({ title: result.error || '操作失败', icon: 'none' })
              return
            }
            this._runRescreenLoop(result.removed || 0, { checked: 0, moved: 0, failed: 0, skipped: 0 })
          },
          fail: () => {
            wx.hideLoading()
            wx.showToast({ title: '网络错误', icon: 'error' })
          },
        })
      },
    })
  },

  _runRescreenLoop(removedSingles: number, acc: { checked: number; moved: number; failed: number; skipped: number }) {
    wx.showLoading({ title: `重新筛选中…(${acc.checked})`, mask: true })
    wx.cloud.callFunction({
      name: 'rescreenAlbums',
      data: {},
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) {
          wx.hideLoading()
          wx.showToast({ title: r.error || '筛选失败', icon: 'none' })
          return
        }
        const next = {
          checked: acc.checked + Number(r.checked || 0),
          moved:   acc.moved   + Number(r.moved   || 0),
          failed:  acc.failed  + Number(r.failed  || 0),
          skipped: acc.skipped + Number(r.skipped || 0),
        }
        if (r.done) {
          wx.hideLoading()
          wx.showModal({
            title: '清理完成',
            content: `删除单曲 ${removedSingles} 条\n重新筛选 ${next.checked} 张，移入候选 ${next.moved} 张${next.failed ? `，请求失败 ${next.failed} 张（可稍后重试或用本地脚本补跑）` : ''}`,
            showCancel: false,
          })
          return
        }
        setTimeout(() => this._runRescreenLoop(removedSingles, next), 2000)
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '网络错误', icon: 'error' })
      },
    })
  },

  onSyncArtistMetadata() {
    if (this.data.metadataSyncing) return
    wx.showModal({
      title: '同步艺人资料',
      content: '将根据已批准 rapper 的网易云 ID，同步头像、粉丝数、专辑数和简介。每批 100 人，自动续跑直到全部完成。',
      confirmText: '开始同步',
      confirmColor: '#C94E25',
      success: (r) => {
        if (!r.confirm) return
        this.setData({ metadataSyncing: true })
        this._syncBatch(0, { updated: 0, skipped: 0, errors: 0 })
      },
    })
  },

  _syncBatch(skip: number, acc: { updated: number; skipped: number; errors: number }) {
    const total = acc.updated + acc.skipped + acc.errors
    wx.showLoading({ title: `同步中…(${total}位)`, mask: true })
    wx.cloud.callFunction({
      name: 'syncArtistMetadata',
      data: { skip, limit: 100 },
      success: (res: any) => {
        const result = res.result || {}
        if (!result.success) {
          wx.hideLoading()
          this.setData({ metadataSyncing: false })
          wx.showToast({ title: result.error || '同步失败', icon: 'none' })
          return
        }
        const next = {
          updated: acc.updated + (result.updated || 0),
          skipped: acc.skipped + (result.skipped || 0),
          errors:  acc.errors  + (result.errors  || 0),
        }
        if (result.hasMore) {
          this._syncBatch(result.nextSkip, next)
        } else {
          wx.hideLoading()
          this.setData({ metadataSyncing: false })
          wx.showModal({
            title: '同步完成',
            content: `共 ${result.total || 0} 位：更新 ${next.updated}，跳过 ${next.skipped}，错误 ${next.errors}。`,
            showCancel: false,
          })
        }
      },
      fail: (err: any) => {
        wx.hideLoading()
        this.setData({ metadataSyncing: false })
        console.error('[syncArtistMetadata] fail', JSON.stringify(err))
        wx.showToast({ title: '网络错误，请重试', icon: 'error' })
      },
    })
  },

  onScheduleToggle(e: WechatMiniprogram.SwitchChange) {
    const enabled = e.detail.value
    this.setData({ crawlerScheduleEnabled: enabled })
    wx.cloud.callFunction({
      name: 'crawlerControl',
      data: { action: 'updateSchedule', enabled, interval: this.data.crawlerScheduleInterval },
    })
  },

  onScheduleInterval(e: WechatMiniprogram.TouchEvent) {
    const interval = (e.currentTarget.dataset as { v: string }).v as 'daily' | 'weekly'
    this.setData({ crawlerScheduleInterval: interval })
    wx.cloud.callFunction({
      name: 'crawlerControl',
      data: { action: 'updateSchedule', enabled: this.data.crawlerScheduleEnabled, interval },
    })
  },
})
