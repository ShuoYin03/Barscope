import { getThemeClass } from '../../utils/theme'

type QQAlbumRow = {
  _id:string
  title:string
  artist:string
  qqAlbumMid:string
  coverUrl:string
  releaseDate?:string
  selected?:boolean
}

Page({
  data:{
    statusBarHeight:20,
    themeClass:'',
    keyword:'',
    loading:false,
    submitting:false,
    list:[] as QQAlbumRow[],
    selectedCount:0,
  },
  onLoad(){
    const app=getApp<IAppOption>()
    this.setData({statusBarHeight:app.globalData.statusBarHeight})
  },
  onShow(){this.setData({themeClass:getThemeClass()});this.loadList()},
  onBack(){wx.navigateBack()},
  onInput(e:WechatMiniprogram.Input){this.setData({keyword:e.detail.value||''})},
  onSearch(){this.loadList()},
  loadList(){
    this.setData({loading:true})
    wx.cloud.callFunction({name:'manageQQAlbumCache',data:{action:'list',keyword:this.data.keyword,limit:100},success:(res:any)=>{
      const r=res.result||{}
      this.setData({loading:false,list:r.success?(r.list||[]):[],selectedCount:0})
      if(!r.success)wx.showToast({title:r.error||'加载失败',icon:'none'})
    },fail:()=>{this.setData({loading:false});wx.showToast({title:'加载失败',icon:'none'})}} as any)
  },
  onToggle(e:WechatMiniprogram.TouchEvent){
    const id=String((e.currentTarget.dataset as any).id||'')
    const list=this.data.list.map(x=>x._id===id?{...x,selected:!x.selected}:x)
    this.setData({list,selectedCount:list.filter(x=>x.selected).length})
  },
  onSelectAll(){
    const allSelected=this.data.list.length>0&&this.data.list.every(x=>x.selected)
    const list=this.data.list.map(x=>({...x,selected:!allSelected}))
    this.setData({list,selectedCount:list.filter(x=>x.selected).length})
  },
  onPromote(){
    const ids=this.data.list.filter(x=>x.selected).map(x=>x._id)
    if(!ids.length){wx.showToast({title:'请先选择专辑',icon:'none'});return}
    this.setData({submitting:true})
    wx.cloud.callFunction({name:'manageQQAlbumCache',data:{action:'promote',ids},success:(res:any)=>{
      const r=res.result||{}
      this.setData({submitting:false})
      if(!r.success){wx.showToast({title:r.error||'送审失败',icon:'none'});return}
      wx.showToast({title:`已送审 ${r.promoted||0} 张`,icon:'success'})
      this.loadList()
    },fail:()=>{this.setData({submitting:false});wx.showToast({title:'送审失败',icon:'none'})}} as any)
  },
})
