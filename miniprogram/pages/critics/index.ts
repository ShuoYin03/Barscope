interface CriticUser {
  openId:      string
  nickName:    string
  avatarUrl:   string
  type:        'critic' | 'normal' | 'admin'
  reviewCount: number
  joinedAt:    string
}

import { getThemeClass } from '../../utils/theme'

let _searchTimer: any = null

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,
    themeClass:      '',

    list:      [] as CriticUser[],
    keyword:   '',
    loading:   false,
    hasMore:   false,
    page:      1,
    pageSize:  20,
    operating: {} as Record<string, boolean>,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight:    app.globalData.topbarHeight,
    })
    this._loadList('', 1)
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  onBack() { wx.navigateBack() },

  _loadList(keyword: string, page: number) {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'manageUsers',
      data: { action: 'listUsers', keyword, page, pageSize: this.data.pageSize },
      success: (res: any) => {
        const r = res.result
        if (!r.success) { this.setData({ loading: false }); return }
        const newList = page === 1 ? r.list : [...this.data.list, ...r.list]
        this.setData({ list: newList, page, hasMore: r.list.length === this.data.pageSize, loading: false })
      },
      fail: () => this.setData({ loading: false }),
    })
  },

  onSearch(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value || ''
    this.setData({ keyword, list: [], page: 1 })
    clearTimeout(_searchTimer)
    _searchTimer = setTimeout(() => this._loadList(keyword, 1), 500)
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this._loadList(this.data.keyword, this.data.page + 1)
  },

  onPullDownRefresh() {
    this._loadList(this.data.keyword, 1)
    wx.stopPullDownRefresh()
  },

  onGrantCritic(e: WechatMiniprogram.TouchEvent) {
    const { openid } = e.currentTarget.dataset as { openid: string }
    this._toggleCritic(openid, 'grantCritic', 'critic')
  },

  onRevokeCritic(e: WechatMiniprogram.TouchEvent) {
    const { openid } = e.currentTarget.dataset as { openid: string }
    this._toggleCritic(openid, 'revokeCritic', 'normal')
  },

  _toggleCritic(openId: string, action: string, newType: 'critic' | 'normal') {
    if (this.data.operating[openId]) return
    this.setData({ operating: { ...this.data.operating, [openId]: true } })

    wx.cloud.callFunction({
      name: 'manageUsers',
      data: { action, openId },
      success: (res: any) => {
        const r = res.result
        const operating = { ...this.data.operating }
        delete operating[openId]
        if (r.success) {
          const list = this.data.list.map((u: CriticUser) =>
            u.openId === openId ? { ...u, type: newType } : u
          )
          this.setData({ list, operating })
          wx.showToast({ title: newType === 'critic' ? '已认证' : '已撤销', icon: 'success' })
        } else {
          this.setData({ operating })
          wx.showToast({ title: '操作失败', icon: 'error' })
        }
      },
      fail: () => {
        const operating = { ...this.data.operating }
        delete operating[openId]
        this.setData({ operating })
        wx.showToast({ title: '网络错误', icon: 'error' })
      },
    })
  },

  onUnload() {
    clearTimeout(_searchTimer)
  },
})
