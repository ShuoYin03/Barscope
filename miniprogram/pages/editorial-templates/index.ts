import { getThemeClass } from '../../utils/theme'

type TemplateKey = 'review' | 'feature' | 'interview'

const TEMPLATES = [
  { key: 'review', label: 'REVIEW', zh: '专辑乐评' },
  { key: 'feature', label: 'FEATURE', zh: '深度专题' },
  { key: 'interview', label: 'INTERVIEW', zh: '人物访谈' },
]

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    templates: TEMPLATES,
    active: 'review' as TemplateKey,
  },
  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
  },
  onShow() { this.setData({ themeClass: getThemeClass() }) },
  onBack() { wx.navigateBack() },
  onTemplateTap(e: WechatMiniprogram.TouchEvent) {
    const key = String((e.currentTarget.dataset as any).key || '') as TemplateKey
    if (TEMPLATES.some(x => x.key === key)) this.setData({ active: key })
  },
  onOpenEditor() {
    wx.navigateTo({ url: `/pages/editorial-editor/index?template=${this.data.active}` })
  },
})
