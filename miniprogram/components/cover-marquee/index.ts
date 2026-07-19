let _rects: WechatMiniprogram.BoundingClientRectCallbackResult[] = []

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
    activeIndex: -1,
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
    // Pausing the marquee's CSS animation on touchstart keeps the covers still under the
    // finger, since matching a moving touch point against bounding rects that shift every
    // frame would otherwise pick the wrong item.
    onTouchStart(e: WechatMiniprogram.TouchEvent) {
      this.setData({ paused: true })
      this.createSelectorQuery()
        .selectAll('.cover-marquee-item')
        .boundingClientRect((rects) => {
          _rects = (rects as unknown as WechatMiniprogram.BoundingClientRectCallbackResult[]) || []
          this._pickActive(e)
        })
        .exec()
    },
    onTouchMove(e: WechatMiniprogram.TouchEvent) {
      this._pickActive(e)
    },
    onTouchEnd() {
      _rects = []
      this.setData({ paused: false, activeIndex: -1 })
    },
    _pickActive(e: WechatMiniprogram.TouchEvent) {
      const touch = e.touches && e.touches[0]
      if (!touch || !_rects.length) return
      let idx = -1
      for (let i = 0; i < _rects.length; i++) {
        const r = _rects[i]
        if (touch.clientX >= r.left && touch.clientX <= r.right && touch.clientY >= r.top && touch.clientY <= r.bottom) {
          idx = i
          break
        }
      }
      if (idx !== this.data.activeIndex) this.setData({ activeIndex: idx })
    },
  },
})
