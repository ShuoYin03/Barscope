Component({
  properties: {
    review: { type: Object, value: null },
    showAlbum: { type: Boolean, value: false },
  },
  methods: {
    onTap() {
      this.triggerEvent('tap', { review: this.properties.review })
    },
    onLike() {
      const review = this.properties.review as any
      this.triggerEvent('like', { reviewId: review && review._id })
    },
  },
})
