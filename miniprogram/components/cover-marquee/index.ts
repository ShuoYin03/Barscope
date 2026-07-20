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
    duration: '24s',
    paused: false,
  },
  observers: {
    'list, secondsPerItem'(list: any[], secondsPerItem: number) {
      const perItem = Number(secondsPerItem || 3)
      const seconds = Math.max(16, (list || []).length * perItem)
      this.setData({ duration: seconds + 's' })
    },
  },
  methods: {
    onCoverTap(e: WechatMiniprogram.TouchEvent) {
      const id = (e.currentTarget.dataset as any).id
      if (id) wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
    },
    onTouchStart() {
      this.setData({ paused: true })
    },
    onTouchEnd() {
      this.setData({ paused: false })
    },
  },
})