import { getThemeClass } from '../../utils/theme'

type ReviewSection = 'candidates' | 'reports' | 'tracks' | 'critics' | 'interviews'

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    candidateCount: 0,
    reportCount: 0,
    trackCorrectionCount: 0,
    interviewCount: 0,
    loading: false,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
    })
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
    this._loadCounts()
  },

  onBack() {
    wx.navigateBack()
  },

  _loadCounts() {
    this.setData({ loading: true })
    Promise.allSettled([
      wx.cloud.callFunction({ name: 'manageCandidates', data: { action: 'stats' } }),
      wx.cloud.callFunction({ name: 'reviewModeration', data: { action: 'stats' } }),
      wx.cloud.callFunction({ name: 'manageTrackCorrections', data: { action: 'stats' } }),
      wx.cloud.callFunction({ name: 'manageInterviews', data: { action: 'stats' } }),
    ]).then((results: any[]) => {
      const candidateResult = results[0]?.status === 'fulfilled' ? results[0].value?.result : null
      const reportResult = results[1]?.status === 'fulfilled' ? results[1].value?.result : null
      const trackResult = results[2]?.status === 'fulfilled' ? results[2].value?.result : null
      const interviewResult = results[3]?.status === 'fulfilled' ? results[3].value?.result : null
      this.setData({
        candidateCount: candidateResult?.success ? (candidateResult.pending || 0) : 0,
        reportCount: reportResult?.success ? (reportResult.pending || 0) : 0,
        trackCorrectionCount: trackResult?.success ? (trackResult.pending || 0) : 0,
        interviewCount: interviewResult?.success ? (interviewResult.pending || 0) : 0,
        loading: false,
      })
    })
  },

  onSectionTap(e: WechatMiniprogram.TouchEvent) {
    const section = (e.currentTarget.dataset as { section: ReviewSection }).section
    const routes: Record<ReviewSection, string> = {
      candidates: '/pages/admin/index',
      reports: '/pages/review-reports/index',
      tracks: '/pages/track-corrections/index',
      critics: '/pages/critics/index',
      interviews: '/pages/interview-review/index',
    }
    wx.navigateTo({ url: routes[section] })
  },
})
