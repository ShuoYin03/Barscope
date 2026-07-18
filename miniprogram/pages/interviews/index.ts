import { getThemeClass } from '../../utils/theme'

interface InterviewCard { _id: string; title: string; intervieweeName: string; intro: string; coverUrl: string; submitterName: string; publishedAtDisplay: string }
interface MyInterview { _id: string; title: string; status: 'pending' | 'published' | 'rejected'; reviewNote: string; createdAtDisplay: string }

function formatDate(value: any): string {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

const STATUS_LABEL: Record<string, string> = { pending: '审核中', published: '已发布', rejected: '已驳回' }

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    isLoggedIn: false,
    tab: 'browse' as 'browse' | 'submit',

    list: [] as InterviewCard[],
    loading: false,
    page: 1,
    hasMore: true,
    total: 0,

    title: '',
    intervieweeName: '',
    intro: '',
    content: '',
    wechat: '',
    coverUrl: '',
    coverLocalPath: '',
    coverUploading: false,
    submitting: false,

    myList: [] as MyInterview[],
    myLoading: false,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
    this._loadList(1)
  },

  onShow() {
    const app = getApp<IAppOption>()
    this.setData({ themeClass: getThemeClass(), isLoggedIn: !!app.globalData.userInfo })
  },

  onBack() { wx.navigateBack() },

  onTabTap(e: WechatMiniprogram.TouchEvent) {
    const tab = String((e.currentTarget.dataset as any).tab || 'browse') as 'browse' | 'submit'
    if (tab === this.data.tab) return
    this.setData({ tab })
    if (tab === 'submit' && this.data.isLoggedIn && !this.data.myList.length) this._loadMine()
  },

  _loadList(page: number) {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'manageInterviews',
      data: { action: 'list_published', page, pageSize: 20 },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ loading: false }); return }
        const incoming = (r.list || []).map((x: any) => ({ ...x, publishedAtDisplay: formatDate(x.publishedAt) }))
        const list = page === 1 ? incoming : [...this.data.list, ...incoming]
        this.setData({ list, total: r.total || 0, page, hasMore: list.length < (r.total || 0), loading: false })
      },
      fail: () => this.setData({ loading: false }),
    } as any)
  },

  onReachBottom() {
    if (this.data.tab !== 'browse' || this.data.loading || !this.data.hasMore) return
    this._loadList(this.data.page + 1)
  },

  onCardTap(e: WechatMiniprogram.TouchEvent) {
    const id = String((e.currentTarget.dataset as any).id || '')
    if (id) wx.navigateTo({ url: `/pages/interview-detail/index?id=${id}` })
  },

  _requireLogin(): boolean {
    if (this.data.isLoggedIn) return true
    wx.navigateTo({ url: '/pages/login/index' })
    return false
  },

  _loadMine() {
    this.setData({ myLoading: true })
    wx.cloud.callFunction({
      name: 'manageInterviews',
      data: { action: 'get_mine' },
      success: (res: any) => {
        const r = res.result || {}
        this.setData({ myLoading: false })
        if (!r.success) return
        const myList = (r.list || []).map((x: any) => ({ ...x, createdAtDisplay: formatDate(x.createdAt), statusLabel: STATUS_LABEL[x.status] || x.status }))
        this.setData({ myList })
      },
      fail: () => this.setData({ myLoading: false }),
    } as any)
  },

  onFieldInput(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const field = String((e.currentTarget.dataset as any).field || '')
    if (!field) return
    this.setData({ [field]: e.detail.value || '' } as any)
  },

  onChooseCover() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res: any) => {
        const path = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath
        if (!path) return
        this.setData({ coverLocalPath: path, coverUploading: true })
        const ext = (path.split('.').pop() || 'jpg').toLowerCase()
        const cloudPath = `interview-covers/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
        wx.cloud.uploadFile({
          cloudPath,
          filePath: path,
          success: (up: any) => { this.setData({ coverUploading: false, coverUrl: up.fileID }) },
          fail: () => { this.setData({ coverUploading: false }); wx.showToast({ title: '封面上传失败', icon: 'none' }) },
        } as any)
      },
    } as any)
  },

  onSubmit() {
    if (!this._requireLogin()) return
    if (this.data.submitting || this.data.coverUploading) return
    const title = this.data.title.trim()
    const intervieweeName = this.data.intervieweeName.trim()
    const content = this.data.content.trim()
    if (title.length < 2) { wx.showToast({ title: '请填写标题', icon: 'none' }); return }
    if (!intervieweeName) { wx.showToast({ title: '请填写受访对象', icon: 'none' }); return }
    if (content.length < 200) { wx.showToast({ title: '正文内容至少 200 字', icon: 'none' }); return }

    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中…', mask: true })
    wx.cloud.callFunction({
      name: 'manageInterviews',
      data: {
        action: 'submit',
        title,
        intervieweeName,
        intro: this.data.intro.trim(),
        content,
        coverUrl: this.data.coverUrl,
        wechat: this.data.wechat.trim(),
      },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { wx.showToast({ title: r.error || '提交失败', icon: 'none' }); return }
        this.setData({ title: '', intervieweeName: '', intro: '', content: '', wechat: '', coverUrl: '', coverLocalPath: '' })
        wx.showToast({ title: '已提交，等待编辑部审核', icon: 'success' })
        this._loadMine()
      },
      fail: () => wx.showToast({ title: '网络错误，请重试', icon: 'none' }),
      complete: () => { wx.hideLoading(); this.setData({ submitting: false }) },
    } as any)
  },
})
