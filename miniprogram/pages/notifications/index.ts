import { getThemeClass } from '../../utils/theme'

const TYPE_ICON: Record<string, string> = { like: '♥', reply: '⤷', report_result: '⚑' }

Page({
  data:{statusBarHeight:20,themeClass:'',list:[] as any[],loading:true,loadError:''},
  onLoad(){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight});this.loadList()},
  onShow(){this.setData({themeClass:getThemeClass()});this.loadList()},
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
  onItemTap(e:WechatMiniprogram.TouchEvent){
    const albumId=(e.currentTarget.dataset as any).albumId
    if(albumId)wx.navigateTo({url:`/pages/album-detail/index?id=${albumId}`})
  },
  onBack(){wx.navigateBack()}
})
