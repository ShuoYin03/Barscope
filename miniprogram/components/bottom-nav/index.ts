Component({
  properties: {
    selected: { type: Number, value: 0 },
  },
  data: {
    tabs: [
      { icon: '⊞', text: '首页', path: '/pages/home/index' },
      { icon: '↑', text: '榜单', path: '/pages/charts/index' },
      { icon: '◎', text: '发现', path: '/pages/discover/index' },
      { icon: '☆', text: '收藏', path: '/pages/favorites/index' },
      { icon: '○', text: '我的', path: '/pages/profile/index' },
    ],
  },
  methods: {
    onTap(e: WechatMiniprogram.TouchEvent) {
      const { path, index } = e.currentTarget.dataset as { path: string; index: number }
      if (index === this.properties.selected) return
      wx.switchTab({ url: path })
    },
  },
})
