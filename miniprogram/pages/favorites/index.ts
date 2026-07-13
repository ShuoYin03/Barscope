interface FavAlbum {
  id:       string
  title:    string
  artist:   string
  year:     number
  score:    number
  genres:   string[]
  coverUrl: string
}

function mapAlbum(a: any): FavAlbum {
  return {
    id:       a._id,
    title:    a.title      || '',
    artist:   a.artist     || '',
    year:     a.releaseYear || 0,
    score:    Math.round((a.avgScore || 0) * 10) / 10,
    genres:   a.genres     || [],
    coverUrl: a.coverUrl   || '',
  }
}

import { getThemeClass } from '../../utils/theme'

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,
    themeClass:      '',
    isLoggedIn:      false,
    favorites:       [] as FavAlbum[],
    loading:         false,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight:    app.globalData.topbarHeight,
    })
  },

  onShow() {
    if (typeof this.getTabBar === 'function') {
      this.getTabBar()?.setData({ selected: 3 })
    }
    this.setData({ themeClass: getThemeClass() })
    const app = getApp<IAppOption>()
    const loggedIn = !!app.globalData.userInfo
    this.setData({ isLoggedIn: loggedIn })

    if (loggedIn) {
      this._loadFavorites()
    } else {
      this.setData({ favorites: [] })
    }
  },

  _loadFavorites() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'getFavorites',
      data: {},
      success: (res: any) => {
        const result = res.result
        if (!result.success) { this.setData({ loading: false }); return }
        const favorites = (result.list || []).map(mapAlbum)
        this.setData({ favorites, loading: false })
      },
      fail: () => {
        this.setData({ loading: false })
      },
    } as any)
  },

  onLogin() {
    wx.navigateTo({ url: '/pages/login/index' })
  },

  onGoDiscover() {
    wx.switchTab({ url: '/pages/discover/index' })
  },

  onAlbumTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id
    wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
  },
})
