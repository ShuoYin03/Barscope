Component({
  properties: {
    value: { type: Number, value: 0 },
    readonly: { type: Boolean, value: false },
  },
  data: {
    stars: [1, 2, 3, 4, 5],
  },
  methods: {
    onStar(e: WechatMiniprogram.TouchEvent) {
      if (this.properties.readonly) return
      const v = (e.currentTarget.dataset as { v: number }).v
      this.triggerEvent('change', { value: v })
    },
  },
})
