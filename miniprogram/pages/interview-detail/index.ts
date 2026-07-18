import { getThemeClass } from '../../utils/theme'

function formatDate(value: any): string {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// Submissions are one continuous text field, not structured Q&A blocks — split on blank lines
// (falling back to single newlines) so the article body can render as normal magazine paragraphs,
// with the opening paragraph getting the drop-cap treatment.
function splitParagraphs(content: string): string[] {
  const raw = String(content || '').trim()
  if (!raw) return []
  const blocks = raw.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  return blocks.length > 1 ? blocks : raw.split(/\n/).map(p => p.trim()).filter(Boolean)
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    loading: true,
    loadError: '',
    interview: null as any,
    publishedAtDisplay: '',
    dropcapChar: '',
    firstParagraphRest: '',
    restParagraphs: [] as string[],
  },

  onLoad(options: any) {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
    const id = String(options.id || '')
    if (!id) { this.setData({ loading: false, loadError: '缺少访谈 ID' }); return }
    this._load(id)
  },

  onShow() { this.setData({ themeClass: getThemeClass() }) },

  onBack() { wx.navigateBack() },

  _load(id: string) {
    this.setData({ loading: true, loadError: '' })
    wx.cloud.callFunction({
      name: 'manageInterviews',
      data: { action: 'get', id },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ loading: false, loadError: r.error || '加载失败' }); return }
        const paragraphs = splitParagraphs(r.interview.content)
        const first = paragraphs[0] || ''
        this.setData({
          loading: false,
          interview: r.interview,
          publishedAtDisplay: formatDate(r.interview.publishedAt),
          dropcapChar: first.slice(0, 1),
          firstParagraphRest: first.slice(1),
          restParagraphs: paragraphs.slice(1),
        })
      },
      fail: () => this.setData({ loading: false, loadError: '网络错误，请重试' }),
    } as any)
  },
})
