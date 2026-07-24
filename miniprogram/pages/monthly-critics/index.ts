import { getThemeClass } from '../../utils/theme'

Page({
  data: { statusBarHeight: 20, topbarHeight: 64, themeClass: '', loading: true, list: [] as any[] },
  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
    this.loadData()
  },
  onShow() { this.setData({ themeClass: getThemeClass() }) },
  loadData() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'getReviews',
      data: { monthlyTopCritics: true, limit: 100 },
      success: (res: any) => {
        const r = res.result || {}
        const list = r.success ? (r.list || []).map((c: any) => ({ ...c, initial: c.nickName ? c.nickName[0] : '?' })) : []
        this.setData({ list, loading: false })
      },
      fail: () => this.setData({ loading: false }),
    } as any)
  },
  onUserTap(e: WechatMiniprogram.TouchEvent) {
    const openId = String((e.currentTarget.dataset as any).openId || '')
    if (openId) wx.navigateTo({ url: `/pages/user/index?openId=${encodeURIComponent(openId)}` })
  },
  onBack() { wx.navigateBack() },
})