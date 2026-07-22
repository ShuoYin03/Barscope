Component({
  properties: {
    list: {
      type: Array,
      value: [] as any[],
    },
    itemSize: {
      type: Number,
      value: 200,
    },
    secondsPerItem: {
      type: Number,
      value: 3,
    },
  },
  data: {
    activeIndex: -1,
  },
  methods: {
    onCoverTap(e: WechatMiniprogram.TouchEvent) {
      const id = (e.currentTarget.dataset as any).id
      if (id) wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
    },
    onItemTouchStart(e: WechatMiniprogram.TouchEvent) {
      const index = Number((e.currentTarget.dataset as any).index ?? -1)
      this.setData({ activeIndex: index })
    },
    onItemTouchEnd() {
      this.setData({ activeIndex: -1 })
    },
  },
})
