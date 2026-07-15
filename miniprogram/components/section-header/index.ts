Component({
  properties: {
    // 分区序号字母，如 'A' / 'B' / 'C'，默认渲染成 "SIDE A — 标题"
    side: { type: String, value: 'A' },
    // 可覆盖默认 SIDE 前缀，例如首页独立专栏使用“专栏 — 历史上的今天”
    prefix: { type: String, value: 'SIDE' },
    title: { type: String, value: '' },
    more: { type: Boolean, value: false },
  },
  methods: {
    onMore() {
      this.triggerEvent('more')
    },
  },
})