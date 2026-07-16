import { getThemeClass } from '../../utils/theme'

const ARTICLES: any = {
  '2026-top-10': {
    category: '年度企划',
    title: '2026 中文说唱十大专辑',
    intro: '从 2026 年发行的专辑里选出你心中的十张，按喜爱程度排出 1-10 名，写下理由，所有人的榜单都会公开展示。专辑会随时间不断发行，你可以随时调整，直到 2026-12-31 截止。',
  },
  'long-review-template': {
    category: '深度长评',
    title: '深度乐评征稿中',
    intro: '告诉我们你想写哪张专辑、为什么值得写，以及你准备从什么角度展开。留下微信号，编辑部会与你详谈。',
    proposalPlaceholder: '例如：《专辑名》深度乐评',
    ideaPlaceholder: '写下你的核心观点、切入角度，以及为什么这张专辑值得被认真讨论。',
    outlinePlaceholder: '可以列出文章大纲、重点曲目或已有样稿。',
  },
  'rapper-interview': {
    category: '人物访谈',
    title: 'Rapper 心里话',
    intro: '可以推荐采访对象，也可以由 Rapper、Producer、DJ 或厂牌成员本人发起。写下想聊的话题，并留下微信号详谈。',
    proposalPlaceholder: '例如：和 XXX 聊聊作品之外的生活',
    ideaPlaceholder: '介绍采访对象、想聊的主题，以及为什么这次对话值得被记录。',
    outlinePlaceholder: '可以列出问题方向、采访形式或已确认的嘉宾信息。',
  },
}

interface Top10Entry { albumId: string; title: string; artist: string; coverUrl: string; note: string }
interface Top10Ballot { _id?: string; userNickName: string; userAvatarUrl: string; entries: Top10Entry[]; updatedAt: any; updatedAtDisplay?: string }

function formatBallotDate(value: any): string {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

let _pickerTimer: any = null
const PICKER_MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']
const titleCollator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { sensitivity: 'base', numeric: true })

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    featureId: '',
    article: null as any,
    isTop10: false,
    isLoggedIn: false,

    // ── proposal form (long-review-template / rapper-interview) ──
    proposalTitle: '',
    idea: '',
    outline: '',
    wechat: '',
    links: '',
    submitting: false,

    // ── top10 vote ──
    top10Tab: 'mine' as 'mine' | 'community',
    votingOpen: true,
    voterTotal: 0,
    myEntries: [] as Top10Entry[],
    myLoading: false,
    mySaving: false,
    pickerVisible: false,
    pickerKeyword: '',
    pickerSearching: false,
    pickerResults: [] as any[],
    pickerLoading: false,
    pickerAllLoading: false,
    pickerAllLoaded: false,
    pickerAllGroups: [] as { month: string; list: any[] }[],
    pickerActiveMonth: '',
    pickerScrollIntoView: '',
    communityList: [] as Top10Ballot[],
    communityLoading: false,
    communityPage: 1,
    communityHasMore: false,
    communityTotal: 0,
  },

  onLoad(options: any) {
    const app = getApp<IAppOption>()
    const featureId = String(options.id || '2026-top-10')
    const isTop10 = featureId === '2026-top-10'
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
      isLoggedIn: !!app.globalData.userInfo,
      featureId,
      isTop10,
      article: ARTICLES[featureId] || ARTICLES['2026-top-10'],
    })
    if (isTop10) {
      this._loadMyBallot()
      this._loadStats()
    }
  },

  onShow() {
    const app = getApp<IAppOption>()
    this.setData({ themeClass: getThemeClass(), isLoggedIn: !!app.globalData.userInfo })
  },

  onFieldInput(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const field = String((e.currentTarget.dataset as any).field || '')
    if (!field) return
    this.setData({ [field]: e.detail.value || '' } as any)
  },

  onSubmit() {
    if (this.data.submitting) return
    const proposalTitle = this.data.proposalTitle.trim()
    const idea = this.data.idea.trim()
    const wechat = this.data.wechat.trim()
    if (proposalTitle.length < 2) { wx.showToast({ title: '请填写项目标题', icon: 'none' }); return }
    if (idea.length < 30) { wx.showToast({ title: '项目想法至少 30 字', icon: 'none' }); return }
    if (wechat.length < 3) { wx.showToast({ title: '请填写微信号', icon: 'none' }); return }

    wx.showModal({
      title: '提交企划？',
      content: '提交后，编辑部将通过你留下的微信号联系。内容不会公开展示。',
      confirmText: '确认提交',
      confirmColor: '#D45124',
      success: (modal) => {
        if (!modal.confirm) return
        this.setData({ submitting: true })
        wx.showLoading({ title: '提交中…', mask: true })
        wx.cloud.callFunction({
          name: 'submitFeatureProposal',
          data: {
            featureId: this.data.featureId,
            featureTitle: this.data.article.title,
            category: this.data.article.category,
            proposalTitle,
            idea,
            outline: this.data.outline.trim(),
            wechat,
            links: this.data.links.trim(),
          },
          success: (res: any) => {
            const result = res.result || {}
            if (!result.success) { wx.showToast({ title: result.error || '提交失败', icon: 'none' }); return }
            this.setData({ proposalTitle: '', idea: '', outline: '', wechat: '', links: '' })
            wx.showToast({ title: '企划已提交', icon: 'success' })
          },
          fail: () => wx.showToast({ title: '网络错误，请重试', icon: 'none' }),
          complete: () => { wx.hideLoading(); this.setData({ submitting: false }) },
        } as any)
      },
    })
  },

  // ── top10 vote：我的榜单 ──────────────────────────────────────────────
  _loadMyBallot() {
    this.setData({ myLoading: true })
    wx.cloud.callFunction({
      name: 'manageTop10Vote',
      data: { action: 'get_mine' },
      success: (res: any) => {
        const r = res.result || {}
        this.setData({ myLoading: false })
        if (!r.success) { if (r.error && r.error !== '请先登录') wx.showToast({ title: r.error, icon: 'none' }); return }
        this.setData({ myEntries: r.entries || [], votingOpen: r.votingOpen !== false })
      },
      fail: () => this.setData({ myLoading: false }),
    } as any)
  },

  _loadStats() {
    wx.cloud.callFunction({
      name: 'manageTop10Vote',
      data: { action: 'stats' },
      success: (res: any) => {
        const r = res.result || {}
        if (r.success) this.setData({ voterTotal: r.total || 0, votingOpen: r.votingOpen !== false })
      },
    } as any)
  },

  onTop10TabTap(e: WechatMiniprogram.TouchEvent) {
    const tab = (e.currentTarget.dataset as any).tab as 'mine' | 'community'
    if (tab === this.data.top10Tab) return
    this.setData({ top10Tab: tab })
    if (tab === 'community' && !this.data.communityList.length) this._loadCommunity(1)
  },

  _loadCommunity(page: number) {
    this.setData({ communityLoading: true })
    wx.cloud.callFunction({
      name: 'manageTop10Vote',
      data: { action: 'list_public', page, pageSize: 20 },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ communityLoading: false }); return }
        const incoming = (r.list || []).map((d: any) => ({ ...d, updatedAtDisplay: formatBallotDate(d.updatedAt) }))
        const communityList = page === 1 ? incoming : [...this.data.communityList, ...incoming]
        this.setData({
          communityList,
          communityTotal: r.total || 0,
          communityPage: page,
          communityHasMore: communityList.length < (r.total || 0),
          communityLoading: false,
        })
      },
      fail: () => this.setData({ communityLoading: false }),
    } as any)
  },

  onCommunityReachBottom() {
    if (this.data.top10Tab !== 'community' || !this.data.communityHasMore || this.data.communityLoading) return
    this._loadCommunity(this.data.communityPage + 1)
  },

  _requireLogin(): boolean {
    if (this.data.isLoggedIn) return true
    wx.navigateTo({ url: '/pages/login/index' })
    return false
  },

  onOpenPicker() {
    if (!this._requireLogin()) return
    if (!this.data.votingOpen) { wx.showToast({ title: '投票已截止', icon: 'none' }); return }
    if (this.data.myEntries.length >= 10) { wx.showToast({ title: '最多选择 10 张专辑', icon: 'none' }); return }
    this.setData({ pickerVisible: true, pickerKeyword: '', pickerSearching: false, pickerResults: [] })
    if (!this.data.pickerAllLoaded) this._loadPickerAll()
  },

  onClosePicker() { this.setData({ pickerVisible: false }) },
  noop() {},

  _loadPickerAll() {
    this.setData({ pickerAllLoading: true })
    Promise.all(PICKER_MONTHS.map(month => wx.cloud.callFunction({
      name: 'getAlbums',
      data: { year: '2026', month, page: 1, pageSize: 100, sortBy: 'releaseYear' },
    }).catch(() => ({ result: { success: false, list: [] } }))))
      .then((results: any[]) => {
        const groups = PICKER_MONTHS.map((month, i) => {
          const r = (results[i] && results[i].result) || {}
          const list = (r.success ? (r.list || []) : []).slice().sort((a: any, b: any) => titleCollator.compare(a.title || '', b.title || ''))
          return { month, list }
        }).filter(g => g.list.length > 0)
        this.setData({ pickerAllGroups: groups, pickerAllLoading: false, pickerAllLoaded: true })
      })
  },

  onPickerMonthTap(e: WechatMiniprogram.TouchEvent) {
    const month = String((e.currentTarget.dataset as any).month || '')
    if (!month) return
    this.setData({ pickerActiveMonth: month, pickerScrollIntoView: 'picker-month-' + month })
  },

  onPickerInput(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value || ''
    const trimmed = keyword.trim()
    this.setData({ pickerKeyword: keyword, pickerSearching: !!trimmed })
    clearTimeout(_pickerTimer)
    if (!trimmed) { this.setData({ pickerResults: [] }); return }
    _pickerTimer = setTimeout(() => this._searchPicker(trimmed), 350)
  },

  _searchPicker(keyword: string) {
    this.setData({ pickerLoading: true })
    wx.cloud.callFunction({
      name: 'getAlbums',
      data: { year: '2026', keyword, page: 1, pageSize: 30, sortBy: 'relevance' },
      success: (res: any) => {
        const r = res.result || {}
        const pickedIds = new Set(this.data.myEntries.map((x: Top10Entry) => x.albumId))
        const list = (r.success ? (r.list || []) : []).filter((a: any) => !pickedIds.has(a._id))
        this.setData({ pickerResults: list, pickerLoading: false })
      },
      fail: () => this.setData({ pickerLoading: false }),
    } as any)
  },

  onPickerSelect(e: WechatMiniprogram.TouchEvent) {
    const id = String((e.currentTarget.dataset as any).id || '')
    const source = this.data.pickerSearching ? this.data.pickerResults : this.data.pickerAllGroups.flatMap((g: any) => g.list)
    const album = source.find((a: any) => a._id === id)
    if (!album) return
    if (this.data.myEntries.some((x: Top10Entry) => x.albumId === id)) { wx.showToast({ title: '已经选过这张了', icon: 'none' }); return }
    if (this.data.myEntries.length >= 10) { wx.showToast({ title: '最多选择 10 张专辑', icon: 'none' }); return }
    const entry: Top10Entry = { albumId: album._id, title: album.title || '', artist: album.artist || album.primaryArtist || '', coverUrl: album.coverUrl || '', note: '' }
    this.setData({ myEntries: [...this.data.myEntries, entry], pickerVisible: false })
  },

  onRemoveEntry(e: WechatMiniprogram.TouchEvent) {
    const index = Number((e.currentTarget.dataset as any).index)
    this.setData({ myEntries: this.data.myEntries.filter((_x, i) => i !== index) })
  },

  onMoveEntry(e: WechatMiniprogram.TouchEvent) {
    const index = Number((e.currentTarget.dataset as any).index)
    const dir = String((e.currentTarget.dataset as any).dir || '')
    const target = dir === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= this.data.myEntries.length) return
    const myEntries = [...this.data.myEntries]
    const tmp = myEntries[index]; myEntries[index] = myEntries[target]; myEntries[target] = tmp
    this.setData({ myEntries })
  },

  onEntryNoteInput(e: WechatMiniprogram.TextareaInput) {
    const index = Number((e.currentTarget.dataset as any).index)
    const value = e.detail.value || ''
    this.setData({ myEntries: this.data.myEntries.map((x: Top10Entry, i: number) => i === index ? { ...x, note: value } : x) })
  },

  onSaveBallot() {
    if (!this._requireLogin()) return
    if (this.data.mySaving) return
    if (!this.data.votingOpen) { wx.showToast({ title: '投票已截止', icon: 'none' }); return }
    this.setData({ mySaving: true })
    wx.showLoading({ title: '保存中…', mask: true })
    const entries = this.data.myEntries.map((x: Top10Entry) => ({ albumId: x.albumId, note: x.note }))
    wx.cloud.callFunction({
      name: 'manageTop10Vote',
      data: { action: 'submit', entries },
      success: (res: any) => {
        wx.hideLoading()
        this.setData({ mySaving: false })
        const r = res.result || {}
        if (!r.success) { wx.showToast({ title: r.error || '保存失败', icon: 'none' }); return }
        this._loadStats()
        wx.showToast({ title: '已保存', icon: 'success' })
      },
      fail: () => { wx.hideLoading(); this.setData({ mySaving: false }); wx.showToast({ title: '网络错误', icon: 'none' }) },
    } as any)
  },

  onBack() { wx.navigateBack() },
})
