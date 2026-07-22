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
    loopList: [] as any[],
    scrollLeft: 0,
  },
  observers: {
    'list, itemSize'(list: any[], itemSize: number) {
      const source = Array.isArray(list) ? list : []
      const loopList = source.length ? [...source, ...source, ...source] : []
      this.setData({ loopList }, () => this._resetLoopPosition(Number(itemSize || 200)))
    },
  },
  lifetimes: {
    attached() {
      this._startAutoScroll()
    },
    detached() {
      this._stopAutoScroll()
      if ((this as any)._resumeTimer) clearTimeout((this as any)._resumeTimer)
    },
  },
  methods: {
    onCoverTap(e: WechatMiniprogram.TouchEvent) {
      const id = (e.currentTarget.dataset as any).id
      if (id) wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
    },
    onTouchStart(e: WechatMiniprogram.TouchEvent) {
      const index = Number((e.currentTarget.dataset as any).index ?? -1)
      this.setData({ activeIndex: index })
      ;(this as any)._isTouching = true
      this._stopAutoScroll()
      if ((this as any)._resumeTimer) clearTimeout((this as any)._resumeTimer)
    },
    onTouchEnd() {
      this.setData({ activeIndex: -1 })
      ;(this as any)._isTouching = false
      if ((this as any)._resumeTimer) clearTimeout((this as any)._resumeTimer)
      ;(this as any)._resumeTimer = setTimeout(() => this._startAutoScroll(), 800)
    },
    onScroll(e: WechatMiniprogram.ScrollViewScroll) {
      const left = Number(e.detail.scrollLeft || 0)
      ;(this as any)._scrollLeft = left
      const setWidth = Number((this as any)._setWidth || 0)
      if (!setWidth || (this as any)._recentering) return

      let target = left
      if (left < setWidth * 0.45) target = left + setWidth
      else if (left > setWidth * 1.55) target = left - setWidth

      if (target !== left) {
        ;(this as any)._recentering = true
        ;(this as any)._scrollLeft = target
        this.setData({ scrollLeft: target }, () => {
          setTimeout(() => { ;(this as any)._recentering = false }, 0)
        })
      }
    },
    _resetLoopPosition(itemSize: number) {
      const source = this.data.list || []
      if (!source.length) return
      const info = wx.getWindowInfo()
      const rpxToPx = info.windowWidth / 750
      const step = (itemSize + 16) * rpxToPx
      const setWidth = source.length * step
      ;(this as any)._itemStep = step
      ;(this as any)._setWidth = setWidth
      ;(this as any)._scrollLeft = setWidth
      this.setData({ scrollLeft: setWidth })
      this._startAutoScroll()
    },
    _startAutoScroll() {
      const source = this.data.list || []
      if (source.length <= 1 || (this as any)._isTouching || (this as any)._autoTimer) return
      const tickMs = 40
      const step = Number((this as any)._itemStep || 0)
      if (!step) return
      const seconds = Math.max(1, Number(this.data.secondsPerItem || 3))
      const delta = step / ((seconds * 1000) / tickMs)
      ;(this as any)._autoTimer = setInterval(() => {
        if ((this as any)._isTouching) return
        let next = Number((this as any)._scrollLeft || 0) + delta
        const setWidth = Number((this as any)._setWidth || 0)
        if (setWidth && next > setWidth * 1.55) next -= setWidth
        ;(this as any)._scrollLeft = next
        this.setData({ scrollLeft: next })
      }, tickMs)
    },
    _stopAutoScroll() {
      if ((this as any)._autoTimer) {
        clearInterval((this as any)._autoTimer)
        ;(this as any)._autoTimer = null
      }
    },
  },
})