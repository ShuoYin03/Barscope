Component({
  properties: {
    review: { type: Object, value: null },
    showAlbum: { type: Boolean, value: false },
  },
  data: { localLiked: false, liking: false },
  observers: {
    review(review: any) {
      this.setData({ localLiked: !!review?.likedByMe, liking: false })
    },
  },
  methods: {
    onTap() { this.triggerEvent('tap', { review: this.properties.review }) },
    onLike() {
      const review = this.properties.review as any
      if (!review || this.data.localLiked || this.data.liking) return
      this.setData({ localLiked: true, liking: true })
      this.triggerEvent('like', { reviewId: review._id })
    },
    onReply() {
      const review = this.properties.review as any
      this.triggerEvent('reply', { reviewId: review && review._id, userName: review && review.userName })
    },
  },
})
