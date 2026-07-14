import { getThemeClass } from '../../utils/theme'

interface SpecialtyOption {
  value: string
  selected: boolean
}

const SPECIALTY_VALUES = ['专辑长评', '单曲点评', '歌词分析', '制作解析', '说唱文化', '地下场景', '现场演出', '行业观察']

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    loading: true,
    submitting: false,
    existing: null as any,
    specialtyOptions: SPECIALTY_VALUES.map(value => ({ value, selected: false })) as SpecialtyOption[],
    selectedSpecialties: [] as string[],
    wechatId: '',
    reason: '',
    sampleReview: '',
    portfolioUrl: '',
    reasonCount: 0,
    sampleCount: 0,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
    })
    this.loadExisting()
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  onBack() { wx.navigateBack() },

  loadExisting() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'submitCriticApplication',
      data: { action: 'getMine' },
      success: (res: any) => {
        const result = res.result || {}
        this.setData({ existing: result.success ? result.application : null, loading: false })
      },
      fail: () => this.setData({ loading: false }),
    })
  },

  onInput(e: WechatMiniprogram.Input) {
    const field = String((e.currentTarget.dataset as any).field || '')
    const value = e.detail.value || ''
    if (!field) return
    const patch: Record<string, any> = { [field]: value }
    if (field === 'reason') patch.reasonCount = value.length
    if (field === 'sampleReview') patch.sampleCount = value.length
    this.setData(patch)
  },

  onToggleSpecialty(e: WechatMiniprogram.TouchEvent) {
    const value = String((e.currentTarget.dataset as any).value || '')
    if (!value) return

    const selected = this.data.selectedSpecialties.slice()
    const index = selected.indexOf(value)

    if (index >= 0) {
      selected.splice(index, 1)
    } else {
      if (selected.length >= 5) {
        wx.showToast({ title: '最多选择 5 项', icon: 'none' })
        return
      }
      selected.push(value)
    }

    const selectedSet = new Set(selected)
    const specialtyOptions = (this.data.specialtyOptions as SpecialtyOption[]).map(option => ({
      ...option,
      selected: selectedSet.has(option.value),
    }))

    this.setData({ selectedSpecialties: selected, specialtyOptions })
  },

  onSubmit() {
    if (this.data.submitting) return
    const { wechatId, reason, sampleReview, portfolioUrl, selectedSpecialties } = this.data
    if (!wechatId.trim()) { wx.showToast({ title: '请填写微信号', icon: 'none' }); return }
    if (!selectedSpecialties.length) { wx.showToast({ title: '请至少选择一个擅长方向', icon: 'none' }); return }
    if (reason.trim().length < 30) { wx.showToast({ title: '申请理由至少 30 字', icon: 'none' }); return }
    if (sampleReview.trim().length < 100 && !portfolioUrl.trim()) {
      wx.showToast({ title: '请提交 100 字样稿或作品链接', icon: 'none' })
      return
    }

    wx.showModal({
      title: '提交乐评人申请？',
      content: '提交后管理员会根据你的样稿、作品与申请理由进行审核。',
      confirmText: '确认提交',
      confirmColor: '#D45124',
      success: modal => {
        if (!modal.confirm) return
        this.setData({ submitting: true })
        const app = getApp<IAppOption>()
        wx.cloud.callFunction({
          name: 'submitCriticApplication',
          data: {
            action: 'submit',
            wechatId: wechatId.trim(),
            reason: reason.trim(),
            sampleReview: sampleReview.trim(),
            portfolioUrl: portfolioUrl.trim(),
            specialties: selectedSpecialties,
            nickName: app.globalData.userInfo?.nickName || '',
            avatarUrl: app.globalData.userInfo?.avatarUrl || '',
          },
          success: (res: any) => {
            const result = res.result || {}
            if (!result.success) {
              wx.showToast({ title: result.error || '提交失败', icon: 'none' })
              return
            }
            wx.showToast({ title: '申请已提交', icon: 'success' })
            this.loadExisting()
          },
          fail: () => wx.showToast({ title: '网络错误，请稍后重试', icon: 'none' }),
          complete: () => this.setData({ submitting: false }),
        })
      },
    })
  },
})