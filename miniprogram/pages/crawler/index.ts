import { getThemeClass } from '../../utils/theme'

let _pollTimer: any = null

function toMillis(v: any): number {
  if (!v) return 0
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t }
  if (typeof v === 'object' && v.$date) return Number(v.$date) || 0
  return 0
}
function formatAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return '刚刚'
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  return Math.floor(diff / 3600000) + ' 小时前'
}
// 分支值来自 cloudCrawlerDailyTrigger 的 touch()，要跟它实际写入的值保持一致
const HEARTBEAT_BRANCH_LABELS: Record<string, string> = {
  'locked-running': '上一批仍在运行中',
  'auto-idle': '今日已完成，等待明天',
  'no-artists': '暂无已批准艺人',
  'auto-tick': '开始处理新一批',
  'auto-done': '今日全部处理完成',
  'auto-ran': '已处理一批，继续中',
  error: '触发失败',
}
// 定时器每 1 分钟醒一次；超过这个时长没有心跳，基本可以判定触发器没在正常调用
const HEARTBEAT_STALE_MS = 8 * 60 * 1000

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,
    themeClass:      '',

    crawlerStatus:           null as any,
    crawlerTriggering:       false,
    heartbeatText:           '暂无记录',
    heartbeatStale:          false,
    crawlerCompletedText:    '',

    crawlerMode:        'approved' as 'approved' | 'artist' | 'album',
    crawlerParam:       '',
    crawlerProgressPct: 0,
    crawlerNeedsId:     false,
    crawlerPlaceholder: '',
    crawlerDesc:        '云端一键爬取所有已批准 rapper 的全部专辑 + 单曲，并逐位写入运行日志',
    crawlerLastLog:     '',
    crawlerTriggerTime: 0,
    crawlerModes: [
      { key: 'approved', label: '全部已批准', desc: '云端一键爬取所有已批准 rapper 的全部专辑 + 单曲，并逐位写入运行日志', needsId: false, placeholder: '' },
      { key: 'artist',   label: '按艺人ID',   desc: '云端收录指定网易云艺人的全部专辑 + 单曲', needsId: true, placeholder: '网易云艺人 ID，如 49779880' },
      { key: 'album',    label: '按专辑ID',   desc: '云端精确收录单张网易云专辑（含单曲）', needsId: true, placeholder: '网易云专辑 ID' },
    ] as Array<{ key: string; label: string; desc: string; needsId: boolean; placeholder: string }>,
  },

  onLoad() { const app = getApp<IAppOption>(); this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight }) },
  onShow() { this.setData({ themeClass: getThemeClass() }); this._startPoll() },
  onHide() { this._stopPoll() },
  onUnload() { this._stopPoll() },
  onBack() { wx.navigateBack() },

  _startPoll(interval = 2000) { this._stopPoll(); this._fetchStatus(); _pollTimer = setInterval(() => this._fetchStatus(), interval) },
  _stopPoll() { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null } },

  _fetchStatus() {
    wx.cloud.callFunction({
      name: 'cloudCrawler', data: { action: 'getStatus' },
      success: (res: any) => {
        const r = res.result; if (!r.success) return
        const s = r.status || {}, prog = s.progress || {}
        const pct = prog.totalArtists > 0 ? Math.round((prog.processedArtists / prog.totalArtists) * 100) : 0
        const log = s.log || s.logs || []
        const normalizedStatus = Object.assign({}, s, { log })
        const lastLog = log.length > 0 ? (typeof log[0] === 'string' ? log[0] : log[0].text || '') : ''
        const wasTriggering = this.data.crawlerTriggering
        const triggerTime = this.data.crawlerTriggerTime
        let shouldClear = false
        if (wasTriggering) {
          const elapsed = triggerTime > 0 ? Date.now() - triggerTime : 0
          if (s.status === 'running' || s.status === 'error') shouldClear = true
          else if (s.status === 'done' || s.status === 'aborted') { if (elapsed > 3000) shouldClear = true }
          else if (elapsed > 90000) { shouldClear = true; wx.showToast({ title: '启动超时，请检查云函数', icon: 'none' }) }
        }
        const heartbeatMs = toMillis(s.lastTriggerAt)
        const heartbeatDetail = s.lastTriggerBranch === 'error' && s.lastTriggerDetail ? `：${s.lastTriggerDetail}` : ''
        const heartbeatText = heartbeatMs
          ? `${formatAgo(heartbeatMs)} · ${HEARTBEAT_BRANCH_LABELS[s.lastTriggerBranch] || s.lastTriggerBranch || '未知'}${heartbeatDetail}`
          : '暂无记录（定时器可能还没成功调用过）'
        const heartbeatStale = !heartbeatMs || (Date.now() - heartbeatMs) > HEARTBEAT_STALE_MS
        const completedMs = toMillis(s.completedAt)
        const crawlerCompletedText = completedMs ? formatAgo(completedMs) : ''
        this.setData({ crawlerStatus: normalizedStatus, crawlerProgressPct: pct, crawlerLastLog: lastLog, crawlerTriggering: wasTriggering && !shouldClear, heartbeatText, heartbeatStale, crawlerCompletedText })
        if (!this.data.crawlerTriggering && s.status !== 'running') this._startPoll(4000)
      },
    })
  },

  onCrawlerModeTap(e: WechatMiniprogram.TouchEvent) {
    const key = (e.currentTarget.dataset as { key: string }).key
    if (key === this.data.crawlerMode) return
    const m = this.data.crawlerModes.find((x) => x.key === key)
    this.setData({ crawlerMode:key as any, crawlerNeedsId:!!(m && m.needsId), crawlerPlaceholder:(m && m.placeholder) || '', crawlerDesc:(m && m.desc) || '', crawlerParam:'' })
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
    this._triggerCloud(mode, param)
  },

  _triggerCloud(mode: string, param: string) {
    const actionMap: Record<string, string> = { approved: 'allApproved', artist: 'artist', album: 'album' }
    const action = actionMap[mode]
    this.setData({ crawlerTriggering: true, crawlerTriggerTime: Date.now(), crawlerLastLog: '正在启动云端任务…' })
    wx.cloud.callFunction({
      name: 'cloudCrawler', data: mode === 'approved' ? { action } : { action, param },
      success: (res: any) => { const r = res.result || {}; this.setData({ crawlerTriggering: false }); if (r.success) wx.showToast({ title: mode === 'approved' ? '已在云端开始' : `新增 ${r.inserted || 0} 张`, icon: 'success' }); else wx.showToast({ title: r.error || '爬取失败', icon: 'none' }); this._fetchStatus(); if (mode === 'approved') this._startPoll(1500) },
      fail: (e: any) => { console.error('[cloudCrawler] call fail', JSON.stringify(e)); this.setData({ crawlerTriggering: false }); wx.showToast({ title: '启动失败', icon: 'none' }); this._fetchStatus() },
    })
    if (mode === 'approved') { wx.showToast({ title: '已在云端开始', icon: 'success' }); this._startPoll(1500) }
  },

  onCrawlerAbort() { const s = this.data.crawlerStatus; if (!s || (s.status !== 'running' && s.status !== 'pending')) return; wx.showModal({ title:'中止爬虫', content:'确定中止当前任务？已爬取的数据会保留。', confirmText:'中止', confirmColor:'#C0392B', success:(r)=>{ if(!r.confirm)return; wx.cloud.callFunction({ name:'cloudCrawler', data:{ action:'abort' }, success:(res:any)=>{ if(res.result&&res.result.success){ wx.showToast({ title:'已请求中止', icon:'none' }); this._fetchStatus() } else wx.showToast({ title:'操作失败', icon:'error' }) }, fail:()=>wx.showToast({ title:'网络错误', icon:'error' }) }) } }) },
  onCrawlerClearLog() { wx.cloud.callFunction({ name:'cloudCrawler', data:{ action:'clearLog' }, success:()=>{ this._fetchStatus(); wx.showToast({ title:'日志已清除', icon:'success' }) } }) },
  onCleanupSingles() { wx.showModal({ title:'清理专辑库', content:'将删除 trackCount 为 1 或 2 的条目，然后自动重新筛选剩余专辑，操作不可撤销。', confirmText:'开始清理', confirmColor:'#C0392B', success:(r)=>{ if(!r.confirm)return; wx.showLoading({ title:'清除单曲中…', mask:true }); wx.cloud.callFunction({ name:'manageCandidates', data:{ action:'cleanup_singles' }, success:(res:any)=>{ const result=res.result||{}; wx.hideLoading(); if(!result.success){ wx.showToast({ title:result.error||'操作失败', icon:'none' }); return } wx.showToast({ title:'已开始清理', icon:'success' }); this._fetchStatus() }, fail:()=>{ wx.hideLoading(); wx.showToast({ title:'网络错误', icon:'error' }) } }) } }) },
})