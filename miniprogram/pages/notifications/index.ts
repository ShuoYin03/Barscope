import { getThemeClass } from '../../utils/theme'

const TYPE_ICON: Record<string, string> = { like: '♥', reply: '⤷', report_result: '⚑' }

Page({
  data:{statusBarHeight:20,themeClass:'',list:[] as any[],loading:true,loadError:'',feedList:[] as any[],feedLoading:true},
  onLoad(){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight});this.loadList();this.loadFeed()},
  onShow(){this.setData({themeClass:getThemeClass()});this.loadList();this.loadFeed()},
  loadList(){
    this.setData({loading:true,loadError:''})
    wx.cloud.callFunction({name:'notifications',data:{action:'list'},success:(res:any)=>{
      const r=res.result||{}
      if(!r.success){this.setData({loading:false,loadError:r.error||'加载失败'});return}
      const list=(r.list||[]).map((item:any)=>({...item,icon:TYPE_ICON[item.type]||'●'}))
      this.setData({list,loading:false})
      wx.cloud.callFunction({name:'notifications',data:{action:'markAllRead'}})
    },fail:()=>this.setData({loading:false,loadError:'加载失败，请确认云函数已部署'})} as any)
  },
  loadFeed(){
    this.setData({feedLoading:true})
    wx.cloud.callFunction({name:'getReviews',data:{followingFeed:true,pageSize:20},success:(res:any)=>{
      const r=res.result||{}
      const feedList=r.success?(r.list||[]).map((x:any)=>({...x,ratingText:x.rating?Number(x.rating).toFixed(1):'—'})):[]
      this.setData({feedList,feedLoading:false})
    },fail:()=>this.setData({feedLoading:false})} as any)
  },
  onItemTap(e:WechatMiniprogram.TouchEvent){
    const albumId=(e.currentTarget.dataset as any).albumId
    if(albumId)wx.navigateTo({url:`/pages/album-detail/index?id=${albumId}`})
  },
  onUserTap(e:WechatMiniprogram.TouchEvent){
    const openId=(e.currentTarget.dataset as any).openId
    if(openId)wx.navigateTo({url:`/pages/user/index?openId=${openId}`})
  },
  onBack(){wx.navigateBack()}
})
