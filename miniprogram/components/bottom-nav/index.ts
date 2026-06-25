Component({
  properties: {
    selected: { type: Number, value: 0 },
  },
  data: {
    tabs: [
      { icon: '/assets/icons/nav/home.svg',    iconActive: '/assets/icons/nav/home-active.svg',    text: '首页', path: '/pages/home/index' },
      { icon: '/assets/icons/nav/charts.svg',  iconActive: '/assets/icons/nav/charts-active.svg',  text: '榜单', path: '/pages/charts/index' },
      { icon: '/assets/icons/nav/compass.svg', iconActive: '/assets/icons/nav/compass-active.svg', text: '发现', path: '/pages/discover/index' },
      { icon: '/assets/icons/nav/heart.svg',   iconActive: '/assets/icons/nav/heart-active.svg',   text: '收藏', path: '/pages/favorites/index' },
      { icon: '/assets/icons/nav/user.svg',    iconActive: '/assets/icons/nav/user-active.svg',    text: '我的', path: '/pages/profile/index' },
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
