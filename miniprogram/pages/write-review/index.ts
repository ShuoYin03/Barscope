import { getThemeClass } from '../../utils/theme'

const TONEARM_LIFTED_ANGLE = -4
const TONEARM_DROPPED_ANGLE = 10
const TONEARM_MIN_ANGLE = -8
const TONEARM_MAX_ANGLE = 14
const TONEARM_DROP_THRESHOLD = (TONEARM_LIFTED_ANGLE + TONEARM_DROPPED_ANGLE) / 2
const TONEARM_DRAG_SENSITIVITY = 0.25

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    albumId: '',
    albumTitle: '',
    albumCoverUrl: '',
    rating: 0,
    ratingDisplay: '—',
    sliderValue: 5,
    content: '',
    submitting: false,
    needleOnRecord: false,
    tonearmDragging: false,
    tonearmAngle: TONEARM_LIFTED_ANGLE,
  },

  _tonearmStartX: 0,
  _tonearmStartAngle: TONEARM_LIFTED_ANGLE,

  onLoad(options) {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
      albumId: options.albumId || '',
      albumTitle: decodeURIComponent(options.albumTitle || ''),
      albumCoverUrl: decodeURIComponent(options.albumCoverUrl || ''),
    })
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  onBack() {
    wx.navigateBack()
  },

  onTonearmTouchStart(e: WechatMiniprogram.TouchEvent) {
    this._tonearmStartX = e.touches[0].clientX
    this._tonearmStartAngle = this.data.tonearmAngle
    this.setData({ tonearmDragging: true })
  },

  onTonearmTouchMove(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.tonearmDragging) return
    const dx = e.touches[0].clientX - this._tonearmStartX
    let angle = this._tonearmStartAngle - dx * TONEARM_DRAG_SENSITIVITY
    angle = Math.max(TONEARM_MIN_ANGLE, Math.min(TONEARM_MAX_ANGLE, angle))
    this.setData({ tonearmAngle: angle })
  },

  onTonearmTouchEnd() {
    const dropped = this.data.tonearmAngle > TONEARM_DROP_THRESHOLD
    this.setData({
      tonearmDragging: false,
      needleOnRecord: dropped,
      tonearmAngle: dropped ? TONEARM_DROPPED_ANGLE : TONEARM_LIFTED_ANGLE,
    })
  },

  onRateChange(e: WechatMiniprogram.SliderChange) {
    const rating = Math.round(Number(e.detail.value) * 2) / 2
    this.setData({
      rating,
      sliderValue: rating,
      ratingDisplay: rating.toFixed(1),
    })
  },

  onContentInput(e: WechatMiniprogram.Input) {
    this.setData({ content: e.detail.value })
  },

  onSubmit() {
    const { rating, content, submitting, albumId } = this.data
    if (submitting) return
    if (!rating) {
      wx.showToast({ title: '请先给出评分', icon: 'none' })
      return
    }
    const trimmedContent = content.trim()
    if (trimmedContent.length < 10) {
      wx.showToast({ title: '评论内容至少需要 10 个字', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '发布中...' })

    wx.cloud.callFunction({
      name: 'submitReview',
      data: { albumId, albumTitle: this.data.albumTitle, rating, content: trimmedContent },
      success: (res: any) => {
        wx.hideLoading()
        const result = res.result
        if (result.success) {
          wx.showToast({ title: '评论已发布', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 1200)
        } else {
          this.setData({ submitting: false })
          wx.showToast({ title: result.error || '发布失败', icon: 'none' })
        }
      },
      fail: () => {
        wx.hideLoading()
        this.setData({ submitting: false })
        wx.showToast({ title: '网络错误，请重试', icon: 'none' })
      },
    })
  },
})