import { getThemeClass } from '../../utils/theme'

Page({
  data:{
    statusBarHeight:20,themeClass:'',
    openId:'',nickName:'',loading:true,loadError:'',
    badges:[] as any[],earnedCount:0,
  },
  onLoad(options){
    const app=getApp<IAppOption>()
    this.setData({statusBarHeight:app.globalData.statusBarHeight,openId:options.openId||''})
  },
  onShow(){
    this.setData({themeClass:getThemeClass()})
    if(this.data.openId)this.loadBadges()
  },
  loadBadges(){
    this.setData({loading:true,loadError:''})
    wx.cloud.callFunction({name:'getUserProfile',data:{openId:this.data.openId},success:(res:any)=>{
      const r=res.result||{}
      if(!r.success){this.setData({loading:false,loadError:r.error||'加载失败'});return}
      const p=r.profile||{}
      const badges=(p.badges||[]).map((b:any)=>({...b,pct:Math.round((b.current/b.target)*100)}))
      this.setData({
        loading:false,
        nickName:p.nickName||'匿名用户',
        badges,
        earnedCount:badges.filter((b:any)=>b.earned).length,
      })
    },fail:()=>this.setData({loading:false,loadError:'加载失败，请确认云函数已部署'})} as any)
  },
  onBack(){wx.navigateBack()},
})
