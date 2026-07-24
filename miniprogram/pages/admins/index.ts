interface ManagedUser {
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

    list:      [] as ManagedUser[],
    keyword:   '',
    loading:   false,
    hasMore:   false,
    page:      1,
    pageSize:  20,
    operating: {} as Record<string, boolean>,
    selfOpenId: '',
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight:    app.globalData.topbarHeight,
      selfOpenId:      app.globalData.userInfo?.openId || '',
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

  onGrantAdmin(e: WechatMiniprogram.TouchEvent) {
    const { openid, nickname } = e.currentTarget.dataset as { openid: string; nickname: string }
    wx.showModal({
      title: '设为管理员？',
      content: `${nickname || '该用户'} 将获得与你相同的管理员权限，可以审核内容、认证乐评人、修改专辑数据等。`,
      confirmText: '确认设置',
      confirmColor: '#2D6FE0',
      success: modal => {
        if (!modal.confirm) return
        this._toggleAdmin(openid, 'grantAdmin', 'admin')
      },
    })
  },

  onRevokeAdmin(e: WechatMiniprogram.TouchEvent) {
    const { openid } = e.currentTarget.dataset as { openid: string }
    if (openid === this.data.selfOpenId) {
      wx.showToast({ title: '不能撤销自己的管理员身份', icon: 'none' })
      return
    }
    wx.showModal({
      title: '撤销管理员？',
      content: '撤销后该用户将变为普通用户，失去所有管理员权限。',
      confirmText: '确认撤销',
      confirmColor: '#2D6FE0',
      success: modal => {
        if (!modal.confirm) return
        this._toggleAdmin(openid, 'revokeAdmin', 'normal')
      },
    })
  },

  _toggleAdmin(openId: string, action: string, newType: 'admin' | 'normal') {
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
          const list = this.data.list.map((u: ManagedUser) =>
            u.openId === openId ? { ...u, type: newType } : u
          )
          this.setData({ list, operating })
          wx.showToast({ title: newType === 'admin' ? '已设为管理员' : '已撤销', icon: 'success' })
        } else {
          this.setData({ operating })
          wx.showToast({ title: r.error || '操作失败', icon: 'none' })
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
