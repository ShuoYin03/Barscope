import { getThemeClass } from '../../utils/theme'

Page({
  data: {
    statusBarHeight: 20,
    themeClass: '',
    content: '',
    contact: '',
    submitting: false,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight })
  },

  onShow() { this.setData({ themeClass: getThemeClass() }) },

  onContentInput(e: WechatMiniprogram.Input) { this.setData({ content: e.detail.value || '' }) },
  onContactInput(e: WechatMiniprogram.Input) { this.setData({ contact: e.detail.value || '' }) },

  onSubmit() {
    const content = this.data.content.trim()
    if (!content) { wx.showToast({ title: '请填写内容', icon: 'none' }); return }
    if (this.data.submitting) return

    this.setData({ submitting: true })
    wx.cloud.callFunction({
      name: 'submitFeedback',
      data: { content, contact: this.data.contact.trim() },
      success: (res: any) => {
        this.setData({ submitting: false })
        const r = res.result || {}
        if (!r.success) { wx.showToast({ title: r.error || '提交失败', icon: 'none' }); return }
        wx.showModal({
          title: '已收到',
          content: '感谢你的建议，我们会认真看每一条。',
          showCancel: false,
          success: () => wx.navigateBack(),
        })
      },
      fail: () => { this.setData({ submitting: false }); wx.showToast({ title: '网络错误', icon: 'none' }) },
    } as any)
  },

  onBack() { wx.navigateBack() },
})
