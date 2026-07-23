import { getThemeClass } from '../../utils/theme'

interface ArtistOption {
  id: string
  artistId: string
  artistName: string
  picUrl: string
}

interface SelectedArtist {
  docId: string
  artistId: string
  artistName: string
  picUrl: string
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    loading: true,
    submitting: false,
    existing: null as any,
    searching: false,
    searchKeyword: '',
    searchResults: [] as ArtistOption[],
    selectedArtist: null as SelectedArtist | null,
    wechatId: '',
    evidence: '',
    evidenceCount: 0,
  },

  _searchToken: 0,

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
      name: 'submitArtistVerification',
      data: { action: 'getMine' },
      success: (res: any) => {
        const result = res.result || {}
        this.setData({ existing: result.success ? result.application : null, loading: false })
      },
      fail: () => this.setData({ loading: false }),
    })
  },

  onSearchInput(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value || ''
    this.setData({ searchKeyword: keyword })
    if (!keyword.trim()) { this.setData({ searchResults: [] }); return }
    const token = ++this._searchToken
    this.setData({ searching: true })
    wx.cloud.callFunction({
      name: 'getArtists',
      data: { keyword: keyword.trim(), limit: 20 },
      success: (res: any) => {
        if (token !== this._searchToken) return
        const result = res.result || {}
        const list: ArtistOption[] = result.success ? (result.list || []).map((a: any) => ({ id: a.id, artistId: a.artistId, artistName: a.artistName, picUrl: a.picUrl || '' })) : []
        this.setData({ searchResults: list, searching: false })
      },
      fail: () => { if (token === this._searchToken) this.setData({ searching: false }) },
    })
  },

  onSelectArtist(e: WechatMiniprogram.TouchEvent) {
    const dataset = e.currentTarget.dataset as any
    const artist: SelectedArtist = {
      docId: String(dataset.docId || ''),
      artistId: String(dataset.artistId || ''),
      artistName: String(dataset.artistName || ''),
      picUrl: String(dataset.picUrl || ''),
    }
    if (!artist.docId || !artist.artistId) return
    this.setData({ selectedArtist: artist, searchKeyword: '', searchResults: [] })
  },

  onClearArtist() {
    this.setData({ selectedArtist: null })
  },

  onInput(e: WechatMiniprogram.Input) {
    const field = String((e.currentTarget.dataset as any).field || '')
    const value = e.detail.value || ''
    if (!field) return
    const patch: Record<string, any> = { [field]: value }
    if (field === 'evidence') patch.evidenceCount = value.length
    this.setData(patch)
  },

  onSubmit() {
    if (this.data.submitting) return
    const { selectedArtist, wechatId, evidence } = this.data
    if (!selectedArtist) { wx.showToast({ title: '请先选择你要认领的艺人', icon: 'none' }); return }
    if (!wechatId.trim()) { wx.showToast({ title: '请填写微信号', icon: 'none' }); return }
    if (evidence.trim().length < 30) { wx.showToast({ title: '身份证明材料至少 30 字', icon: 'none' }); return }

    wx.showModal({
      title: `申请认领「${selectedArtist.artistName}」？`,
      content: '提交后管理员会根据你提供的联系方式与证明材料进行审核。',
      confirmText: '确认提交',
      confirmColor: '#D45124',
      success: modal => {
        if (!modal.confirm) return
        this.setData({ submitting: true })
        const app = getApp<IAppOption>()
        wx.cloud.callFunction({
          name: 'submitArtistVerification',
          data: {
            action: 'submit',
            artistId: selectedArtist.artistId,
            artistDocId: selectedArtist.docId,
            artistName: selectedArtist.artistName,
            wechatId: wechatId.trim(),
            evidence: evidence.trim(),
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
