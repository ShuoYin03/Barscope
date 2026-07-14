Component({
  properties: {
    list: {
      type: Array,
      value: [] as any[],
    },
  },
  data: {
    duration: '24s',
  },
  observers: {
    list(list: any[]) {
      const seconds = Math.max(12, (list || []).length * 3)
      this.setData({ duration: seconds + 's' })
    },
  },
  methods: {
    onCoverTap(e: WechatMiniprogram.TouchEvent) {
      const id = (e.currentTarget.dataset as any).id
      if (id) wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
    },
  },
})
