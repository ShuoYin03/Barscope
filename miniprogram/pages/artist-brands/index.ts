import { getThemeClass } from '../../utils/theme'

interface ArtistRow { id:string; artistId:string; artistName:string; picUrl:string; albumSize:number; brands:string[] }
Page({
  data:{
    statusBarHeight:20,
    themeClass:'',
    keyword:'',
    list:[] as ArtistRow[],
    loading:true,
    brandSheetVisible:false,
    editingArtistId:'',
    editingArtistName:'',
    brandOptions:[] as string[],
    selectedBrands:[] as string[],
    saving:false,
  },
  onLoad(){ const app=getApp<IAppOption>(); this.setData({statusBarHeight:app.globalData.statusBarHeight}); this.loadArtists() },
  onShow(){ this.setData({themeClass:getThemeClass()}) },
  loadArtists(){
    this.setData({loading:true})
    wx.cloud.callFunction({name:'getArtists',data:{keyword:this.data.keyword.trim(),limit:1000},success:(res:any)=>{
      const r=res.result||{}
      const list:ArtistRow[]=r.success?(r.list||[]):[]
      const brandOptions=Array.from(new Set(list.flatMap(x=>x.brands||[]).map(x=>String(x||'').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'zh-CN'))
      this.setData({list,brandOptions,loading:false})
    },fail:()=>{this.setData({loading:false});wx.showToast({title:'加载失败',icon:'none'})}} as any)
  },
  onSearch(e:WechatMiniprogram.Input){this.setData({keyword:e.detail.value});this.loadArtists()},
  onEdit(e:WechatMiniprogram.TouchEvent){
    const id=String((e.currentTarget.dataset as any).id||'')
    const artist=this.data.list.find(x=>x.id===id)
    if(!artist)return
    this.setData({
      brandSheetVisible:true,
      editingArtistId:id,
      editingArtistName:artist.artistName,
      selectedBrands:[...(artist.brands||[])],
    })
  },
  onToggleBrand(e:WechatMiniprogram.TouchEvent){
    const brand=String((e.currentTarget.dataset as any).brand||'')
    if(!brand)return
    const selected=this.data.selectedBrands.includes(brand)
      ? this.data.selectedBrands.filter(x=>x!==brand)
      : [...this.data.selectedBrands,brand].slice(0,10)
    this.setData({selectedBrands:selected})
  },
  onClearBrands(){this.setData({selectedBrands:[]})},
  onCloseBrandSheet(){if(!this.data.saving)this.setData({brandSheetVisible:false})},
  onSaveBrands(){
    if(this.data.saving||!this.data.editingArtistId)return
    const id=this.data.editingArtistId
    const brands=this.data.selectedBrands
    this.setData({saving:true})
    wx.cloud.callFunction({name:'manageArtistBrands',data:{action:'update',artistDocId:id,brands},success:(res:any)=>{
      const r=res.result||{}
      if(!r.success){wx.showToast({title:r.error||'保存失败',icon:'none'});return}
      this.setData({
        list:this.data.list.map(x=>x.id===id?{...x,brands:r.brands||[]}:x),
        brandSheetVisible:false,
      })
      wx.showToast({title:'已更新',icon:'success'})
    },fail:()=>wx.showToast({title:'保存失败',icon:'none'}),complete:()=>this.setData({saving:false})} as any)
  },
  noop(){},
  onBack(){wx.navigateBack()}
})