Page({
  data:{statusBarHeight:20,albumId:'',title:'',targetArtistName:'',reason:''},
  onLoad(options){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight,albumId:String(options.albumId||''),title:decodeURIComponent(String(options.title||''))})},
  onTargetInput(e:WechatMiniprogram.Input){this.setData({targetArtistName:e.detail.value||''})},
  onReasonInput(e:WechatMiniprogram.Input){this.setData({reason:e.detail.value||''})},
  onSubmit(){const targetArtistName=this.data.targetArtistName.trim();if(!targetArtistName){wx.showToast({title:'请输入 rapper 名称',icon:'none'});return}wx.showLoading({title:'提交中…',mask:true});wx.cloud.callFunction({name:'submitAlbumOwnershipCorrection',data:{albumId:this.data.albumId,targetArtistName,reason:this.data.reason},success:(res:any)=>{wx.hideLoading();const r=res.result||{};if(!r.success){wx.showToast({title:r.error||'提交失败',icon:'none'});return}wx.showModal({title:r.existed?'已在审核中':'已提交',content:`归属修改已提交给管理员复核：${r.targetArtistName || targetArtistName}`,showCancel:false,success:()=>wx.navigateBack()})},fail:()=>{wx.hideLoading();wx.showToast({title:'提交失败',icon:'none'})}} as any)},
  onBack(){wx.navigateBack()}
})
