interface ArtistPick { artistId:string; artistName:string; picUrl:string; albumSize:number; letter:string; selected?:boolean }
let _artistSearchTimer:any=null
Page({
  data:{
    statusBarHeight:20,
    albumId:'',
    title:'',
    artistKeyword:'',
    selectedArtists:[] as ArtistPick[],
    artistResults:[] as ArtistPick[],
    artistSearching:false,
    reason:'',
  },
  onLoad(options){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight,albumId:String(options.albumId||''),title:decodeURIComponent(String(options.title||''))});this.searchArtists('')},
  onTargetInput(e:WechatMiniprogram.Input){const artistKeyword=e.detail.value||'';this.setData({artistKeyword});if(_artistSearchTimer)clearTimeout(_artistSearchTimer);_artistSearchTimer=setTimeout(()=>this.searchArtists(artistKeyword),300)},
  searchArtists(keyword=''){this.setData({artistSearching:true});wx.cloud.callFunction({name:'getArtists',data:{keyword:String(keyword||'').trim(),limit:30},success:(res:any)=>{const r=res.result||{};const selectedIds=new Set(this.data.selectedArtists.map(a=>String(a.artistId)));const artistResults=(r.success?(r.list||[]):[]).map((a:ArtistPick)=>({...a,selected:selectedIds.has(String(a.artistId))}));this.setData({artistResults,artistSearching:false})},fail:(e:any)=>{console.error('[getArtists] fail', e);this.setData({artistSearching:false,artistResults:[]})}} as any)},
  onPickArtist(e:WechatMiniprogram.TouchEvent){const ds=e.currentTarget.dataset as any;const artistId=String(ds.id||'');if(!artistId)return;const selectedArtists=this.data.selectedArtists.slice();const index=selectedArtists.findIndex(a=>String(a.artistId)===artistId);if(index>=0)selectedArtists.splice(index,1);else{const found=this.data.artistResults.find(a=>String(a.artistId)===artistId);if(found)selectedArtists.push({...found,selected:true})}const selectedIds=new Set(selectedArtists.map(a=>String(a.artistId)));const artistResults=this.data.artistResults.map(a=>({...a,selected:selectedIds.has(String(a.artistId))}));this.setData({selectedArtists,artistResults})},
  onRemoveArtist(e:WechatMiniprogram.TouchEvent){const artistId=String((e.currentTarget.dataset as any).id||'');const selectedArtists=this.data.selectedArtists.filter(a=>String(a.artistId)!==artistId);const artistResults=this.data.artistResults.map(a=>({...a,selected:selectedArtists.some(x=>String(x.artistId)===String(a.artistId))}));this.setData({selectedArtists,artistResults})},
  onReasonInput(e:WechatMiniprogram.Input){this.setData({reason:e.detail.value||''})},
  onSubmit(){const targetArtists=this.data.selectedArtists.map(a=>({artistId:String(a.artistId),artistName:String(a.artistName)}));if(!targetArtists.length){wx.showToast({title:'请至少选择一位 rapper',icon:'none'});return}wx.showLoading({title:'提交中…',mask:true});wx.cloud.callFunction({name:'submitAlbumOwnershipCorrection',data:{albumId:this.data.albumId,targetArtists,reason:this.data.reason},success:(res:any)=>{wx.hideLoading();const r=res.result||{};if(!r.success){wx.showToast({title:r.error||'提交失败',icon:'none'});console.error('[submitAlbumOwnershipCorrection] result error', r);return}const names=(r.targetArtistNames||targetArtists.map(x=>x.artistName)).join(' / ');wx.showModal({title:r.existed?'已在审核中':'已提交',content:`归属修改已提交给管理员复核：${names}`,showCancel:false,success:()=>wx.navigateBack()})},fail:(e:any)=>{wx.hideLoading();console.error('[submitAlbumOwnershipCorrection] call fail', e);wx.showToast({title:(e&&e.errMsg)||'提交失败',icon:'none',duration:3000})}} as any)},
  onBack(){wx.navigateBack()}
})