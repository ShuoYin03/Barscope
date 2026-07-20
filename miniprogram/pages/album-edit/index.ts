import { getThemeClass } from '../../utils/theme'

const RELEASE_TYPES = ['LP', 'Mixtape', 'Live', 'Beat Tape']

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    albumId: '',
    title: '',
    coverUrl: '',
    releaseDate: '',
    company: '',
    releaseType: '',
    description: '',
    saving: false,
    uploading: false,
    releaseTypes: RELEASE_TYPES,
  },
  onLoad(options) {
    const app = getApp<IAppOption>()
    const albumId = String(options.albumId || '')
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight, albumId })
    if (!albumId) { wx.showToast({ title: '缺少专辑ID', icon: 'none' }); return }
    wx.cloud.callFunction({ name: 'getAlbums', data: { id: albumId }, success: (res:any) => {
      const a = res.result && res.result.album
      if (!a) { wx.showToast({ title: '专辑不存在', icon: 'none' }); return }
      this.setData({ title: a.title || '', coverUrl: a.coverUrl || '', releaseDate: a.releaseDate || '', company: a.company || '', releaseType: a.releaseType || '', description: a.description || '' })
    } } as any)
  },
  onShow() { this.setData({ themeClass: getThemeClass() }) },
  onBack() { wx.navigateBack() },
  onInput(e:WechatMiniprogram.Input) { const field = String((e.currentTarget.dataset as any).field || ''); if (field) this.setData({ [field]: e.detail.value } as any) },
  onTypeChange(e:WechatMiniprogram.PickerChange) { const index = Number(e.detail.value); this.setData({ releaseType: RELEASE_TYPES[index] || '' }) },
  onChooseCover() {
    if (this.data.uploading) return
    wx.chooseMedia({ count:1, mediaType:['image'], sourceType:['album','camera'], success:(res:any)=>{
      const filePath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath
      if (!filePath) return
      this.setData({ uploading:true }); wx.showLoading({ title:'上传封面…', mask:true })
      const ext = (filePath.split('.').pop() || 'jpg').toLowerCase()
      wx.cloud.uploadFile({ cloudPath:`album-covers/manual/${this.data.albumId}_${Date.now()}.${ext}`, filePath, success:(up:any)=>{ wx.hideLoading(); this.setData({ coverUrl:up.fileID, uploading:false }); wx.showToast({ title:'封面已上传，请保存', icon:'success' }) }, fail:()=>{ wx.hideLoading(); this.setData({ uploading:false }); wx.showToast({ title:'封面上传失败', icon:'none' }) } })
    } })
  },
  onEditOwnership() { wx.navigateTo({ url:`/pages/ownership-submit/index?albumId=${encodeURIComponent(this.data.albumId)}&title=${encodeURIComponent(this.data.title)}` }) },
  onEditTracks() { wx.navigateTo({ url:`/pages/track-edit/index?albumId=${encodeURIComponent(this.data.albumId)}&title=${encodeURIComponent(this.data.title)}` }) },
  onSave() {
    if (this.data.saving) return
    this.setData({ saving:true }); wx.showLoading({ title:'保存中…', mask:true })
    wx.cloud.callFunction({ name:'updateAlbumMetadata', data:{ albumId:this.data.albumId, coverUrl:this.data.coverUrl, releaseDate:String(this.data.releaseDate||'').trim(), company:String(this.data.company||'').trim(), releaseType:this.data.releaseType, description:String(this.data.description||'').trim() }, success:(res:any)=>{ wx.hideLoading(); this.setData({ saving:false }); const r=res.result||{}; if(!r.success){wx.showToast({title:r.error||'保存失败',icon:'none'});return} wx.showToast({title:'专辑信息已更新',icon:'success'}); setTimeout(()=>wx.navigateBack(),600) }, fail:()=>{ wx.hideLoading(); this.setData({ saving:false }); wx.showToast({title:'保存失败',icon:'none'}) } } as any)
  },
})