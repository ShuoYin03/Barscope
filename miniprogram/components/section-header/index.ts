Component({
  properties: {
    // 分区序号字母，如 'A' / 'B' / 'C'，渲染成 "SIDE A — 标题"
    side: { type: String, value: 'A' },
    title: { type: String, value: '' },
    more: { type: Boolean, value: false },
  },
  methods: {
    onMore() {
      this.triggerEvent('more')
    },
  },
})
