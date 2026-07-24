import { getThemeClass } from '../../utils/theme'

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    loading: true,
    list: [] as any[],
    reviewingId: '',
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
    })
    this.loadList()
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  onBack() { wx.navigateBack() },

  loadList() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'submitArtistVerification',
      data: { action: 'list' },
      success: (res: any) => {
        const result = res.result || {}
        this.setData({ list: result.success ? (result.list || []) : [], loading: false })
      },
      fail: () => this.setData({ loading: false }),
    })
  },

  onReview(e: WechatMiniprogram.TouchEvent) {
    if (this.data.reviewingId) return
    const dataset = e.currentTarget.dataset as any
    const applicationId = String(dataset.id || '')
    const decision = String(dataset.decision || '')
    if (!applicationId || !['approve', 'reject'].includes(decision)) return

    wx.showModal({
      title: decision === 'approve' ? '通过该申请？' : '拒绝该申请？',
      content: decision === 'approve' ? '通过后该艺人主页会显示「艺人已入驻」标识。' : '拒绝后申请人可以补充材料重新申请。',
      confirmText: decision === 'approve' ? '通过' : '拒绝',
      confirmColor: '#2D6FE0',
      success: modal => {
        if (!modal.confirm) return
        this.setData({ reviewingId: applicationId })
        wx.cloud.callFunction({
          name: 'submitArtistVerification',
          data: { action: 'review', applicationId, decision },
          success: (res: any) => {
            const result = res.result || {}
            if (!result.success) {
              wx.showToast({ title: result.error || '操作失败', icon: 'none' })
              return
            }
            wx.showToast({ title: decision === 'approve' ? '已通过' : '已拒绝', icon: 'success' })
            this.loadList()
          },
          fail: () => wx.showToast({ title: '网络错误', icon: 'none' }),
          complete: () => this.setData({ reviewingId: '' }),
        })
      },
    })
  },
})
