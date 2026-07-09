interface ArtistPick { artistId:string; artistName:string; picUrl:string; albumSize:number; letter:string }
let _artistSearchTimer:any=null
Page({
  data:{
    statusBarHeight:20,
    albumId:'',
    title:'',
    targetArtistName:'',
    targetArtistId:'',
    artistResults:[] as ArtistPick[],
    artistSearching:false,
    reason:'',
  },
  onLoad(options){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight,albumId:String(options.albumId||''),title:decodeURIComponent(String(options.title||''))});this.searchArtists('')},
  onTargetInput(e:WechatMiniprogram.Input){const targetArtistName=e.detail.value||'';this.setData({targetArtistName,targetArtistId:''});if(_artistSearchTimer)clearTimeout(_artistSearchTimer);_artistSearchTimer=setTimeout(()=>this.searchArtists(targetArtistName),300)},
  searchArtists(keyword=''){this.setData({artistSearching:true});wx.cloud.callFunction({name:'getArtists',data:{keyword:String(keyword||'').trim(),limit:30},success:(res:any)=>{const r=res.result||{};this.setData({artistResults:r.success?(r.list||[]):[],artistSearching:false})},fail:()=>this.setData({artistSearching:false,artistResults:[]})} as any)},
  onPickArtist(e:WechatMiniprogram.TouchEvent){const ds=e.currentTarget.dataset as any;this.setData({targetArtistId:String(ds.id||''),targetArtistName:String(ds.name||'')})},
  onReasonInput(e:WechatMiniprogram.Input){this.setData({reason:e.detail.value||''})},
  onSubmit(){const targetArtistName=this.data.targetArtistName.trim(),targetArtistId=this.data.targetArtistId.trim();if(!targetArtistId){wx.showToast({title:'请先从列表选择 rapper',icon:'none'});return}wx.showLoading({title:'提交中…',mask:true});wx.cloud.callFunction({name:'submitAlbumOwnershipCorrection',data:{albumId:this.data.albumId,targetArtistId,targetArtistName,reason:this.data.reason},success:(res:any)=>{wx.hideLoading();const r=res.result||{};if(!r.success){wx.showToast({title:r.error||'提交失败',icon:'none'});return}wx.showModal({title:r.existed?'已在审核中':'已提交',content:`归属修改已提交给管理员复核：${r.targetArtistName || targetArtistName}`,showCancel:false,success:()=>wx.navigateBack()})},fail:()=>{wx.hideLoading();wx.showToast({title:'提交失败',icon:'none'})}} as any)},
  onBack(){wx.navigateBack()}
})
