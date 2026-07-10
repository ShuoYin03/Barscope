interface ArtistRow { id:string; artistId:string; artistName:string; picUrl:string; albumSize:number; brands:string[] }
Page({
  data:{ statusBarHeight:20, keyword:'', list:[] as ArtistRow[], loading:true },
  onLoad(){ const app=getApp<IAppOption>(); this.setData({statusBarHeight:app.globalData.statusBarHeight}); this.loadArtists() },
  loadArtists(){
    this.setData({loading:true})
    wx.cloud.callFunction({name:'getArtists',data:{keyword:this.data.keyword.trim(),limit:1000},success:(res:any)=>{const r=res.result||{};this.setData({list:r.success?(r.list||[]):[],loading:false})},fail:()=>{this.setData({loading:false});wx.showToast({title:'加载失败',icon:'none'})}} as any)
  },
  onSearch(e:WechatMiniprogram.Input){this.setData({keyword:e.detail.value});this.loadArtists()},
  onEdit(e:WechatMiniprogram.TouchEvent){
    const id=String((e.currentTarget.dataset as any).id||'')
    const artist=this.data.list.find(x=>x.id===id)
    if(!artist)return
    wx.showModal({title:`设置 ${artist.artistName} 的厂牌`,editable:true,placeholderText:'多个厂牌用逗号分隔；留空可清除',content:(artist.brands||[]).join(', '),confirmText:'保存',confirmColor:'#C94E25',success:(modal:any)=>{
      if(!modal.confirm)return
      const brands=String(modal.content||'').split(/[,，]/).map((x:string)=>x.trim()).filter(Boolean)
      wx.showLoading({title:'保存中…',mask:true})
      wx.cloud.callFunction({name:'manageArtistBrands',data:{action:'update',artistDocId:id,brands},success:(res:any)=>{wx.hideLoading();const r=res.result||{};if(!r.success){wx.showToast({title:r.error||'保存失败',icon:'none'});return}wx.showToast({title:'已更新',icon:'success'});this.setData({list:this.data.list.map(x=>x.id===id?{...x,brands:r.brands||[]}:x)})},fail:()=>{wx.hideLoading();wx.showToast({title:'保存失败',icon:'none'})}} as any)
    }})
  },
  onBack(){wx.navigateBack()}
})
