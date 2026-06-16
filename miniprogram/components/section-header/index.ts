Component({
  properties: {
    num: { type: String, value: '01' },
    title: { type: String, value: '' },
    more: { type: Boolean, value: true },
  },
  methods: {
    onMore() {
      this.triggerEvent('more')
    },
  },
})
