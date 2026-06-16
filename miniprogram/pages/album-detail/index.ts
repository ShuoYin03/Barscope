interface ReviewEntry {
  _id:        string
  userType:   'critic' | 'normal'
  userName:   string
  initial:    string
  score:      string
  content:    string
  timeAgo:    string
  likes:      number
  replyCount: number
  albumTitle: string
  isPinned:   boolean
}

interface AlbumData {
  id:          string
  title:       string
  artist:      string
  year:        number
  genres:      string[]
  avgScore:    number
  reviewCount: number
  scoreFill:   string
  coverUrl:    string
}

function mapAlbum(raw: any): AlbumData {
  const score = raw.avgScore || 0
  return {
    id:          raw._id,
    title:       raw.title       || '',
    artist:      raw.artist      || '',
    year:        raw.releaseYear || 0,
    genres:      raw.genres      || [],
    avgScore:    Math.round(score * 10) / 10,
    reviewCount: raw.reviewCount || 0,
    scoreFill:   Math.round(score / 10 * 100) + '%',
    coverUrl:    raw.coverUrl    || '',
  }
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight:    64,
    album:           null as AlbumData | null,
    reviews:         [] as ReviewEntry[],
    isLoggedIn:      false,
    isFavorited:     false,
    loading:         true,
  },

  onLoad(options) {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight:    app.globalData.topbarHeight,
      isLoggedIn:      !!app.globalData.userInfo,
    })

    const id = options.id || ''
    if (!id) {
      wx.showToast({ title: '参数错误', icon: 'error' })
      return
    }

    this._loadAlbum(id)
  },

  _loadAlbum(id: string) {
    // parallel: album info + reviews
    const p1 = wx.cloud.callFunction({ name: 'getAlbums', data: { id } })
    const p2 = wx.cloud.callFunction({ name: 'getReviews', data: { albumId: id, pageSize: 50 } })

    Promise.all([p1, p2]).then((results: any[]) => {
      const albumRes   = results[0].result
      const reviewsRes = results[1].result

      const album  = albumRes.success  ? mapAlbum(albumRes.album) : null
      const reviews: ReviewEntry[] = reviewsRes.success
        ? (reviewsRes.list || []).sort((a: any, b: any) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0))
        : []

      this.setData({ album, reviews, loading: false })
    }).catch(() => {
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'error' })
    })

    // check favorite status (non-blocking)
    if (this.data.isLoggedIn) {
      wx.cloud.callFunction({
        name: 'getFavorites',
        data: { checkAlbum: id },
        success: (res: any) => {
          if (res.result && res.result.success) {
            this.setData({ isFavorited: res.result.isFavorited })
          }
        },
      } as any)
    }
  },

  onBack() {
    wx.navigateBack()
  },

  onWriteReview() {
    if (!this.data.isLoggedIn) {
      wx.navigateTo({ url: '/pages/login/index' })
      return
    }
    const album = this.data.album
    if (!album) return
    wx.navigateTo({
      url: `/pages/write-review/index?albumId=${album.id}&albumTitle=${encodeURIComponent(album.title)}`,
    })
  },

  onLike(e: WechatMiniprogram.CustomEvent) {
    const reviewId = e.detail.reviewId
    if (!reviewId) return

    // optimistic UI update
    const reviews = this.data.reviews.map((r: ReviewEntry) =>
      r._id === reviewId ? { ...r, likes: r.likes + 1 } : r
    )
    this.setData({ reviews })

    // persist to DB
    wx.cloud.callFunction({ name: 'likeReview', data: { reviewId } } as any)
  },

  onFavoriteToggle() {
    if (!this.data.isLoggedIn) {
      wx.navigateTo({ url: '/pages/login/index' })
      return
    }
    const album = this.data.album
    if (!album) return

    const wasFavorited = this.data.isFavorited
    this.setData({ isFavorited: !wasFavorited })  // optimistic

    const fnName = wasFavorited ? 'removeFavorite' : 'addFavorite'
    wx.cloud.callFunction({
      name: fnName,
      data: { albumId: album.id },
      fail: () => {
        this.setData({ isFavorited: wasFavorited })  // rollback
        wx.showToast({ title: '操作失败', icon: 'error' })
      },
    } as any)
  },
})
