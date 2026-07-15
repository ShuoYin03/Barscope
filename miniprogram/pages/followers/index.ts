import { getThemeClass } from '../../utils/theme'

Page({
  data:{
    statusBarHeight:20,themeClass:'',
    openId:'',loading:true,loadError:'',
    list:[] as any[],busyIds:[] as string[],
  },
  onLoad(options){
    const app=getApp<IAppOption>()
    this.setData({statusBarHeight:app.globalData.statusBarHeight,openId:options.openId||''})
  },
  onShow(){
    this.setData({themeClass:getThemeClass()})
    if(this.data.openId)this.loadFollowers()
  },
  loadFollowers(){
    this.setData({loading:true,loadError:''})
    wx.cloud.callFunction({name:'follows',data:{action:'followers',openId:this.data.openId},success:(res:any)=>{
      const r=res.result||{}
      if(!r.success){this.setData({loading:false,loadError:r.error||'加载失败'});return}
      this.setData({loading:false,list:(r.list||[]).map((x:any)=>({...x,initial:x.nickName?x.nickName[0]:'?'}))})
    },fail:()=>this.setData({loading:false,loadError:'加载失败，请确认云函数已部署'})} as any)
  },
  onToggleFollow(e:WechatMiniprogram.TouchEvent){
    const openId=(e.currentTarget.dataset as any).openId
    if(!openId||this.data.busyIds.includes(openId))return
    const item=this.data.list.find((x:any)=>x.openId===openId)
    if(!item)return
    const wasFollowing=item.isFollowing
    this.setData({
      busyIds:[...this.data.busyIds,openId],
      list:this.data.list.map((x:any)=>x.openId===openId?{...x,isFollowing:!wasFollowing}:x),
    })
    wx.cloud.callFunction({name:'follows',data:{action:'toggle',openId},success:(res:any)=>{
      const r=res.result||{}
      this.setData({busyIds:this.data.busyIds.filter((id:string)=>id!==openId)})
      if(!r.success){
        this.setData({list:this.data.list.map((x:any)=>x.openId===openId?{...x,isFollowing:wasFollowing}:x)})
        wx.showToast({title:r.error||'操作失败',icon:'none'})
      }
    },fail:()=>{
      this.setData({
        busyIds:this.data.busyIds.filter((id:string)=>id!==openId),
        list:this.data.list.map((x:any)=>x.openId===openId?{...x,isFollowing:wasFollowing}:x),
      })
      wx.showToast({title:'网络错误',icon:'none'})
    }} as any)
  },
  onUserTap(e:WechatMiniprogram.TouchEvent){
    const openId=(e.currentTarget.dataset as any).openId
    if(openId)wx.navigateTo({url:`/pages/user/index?openId=${openId}`})
  },
  onBack(){wx.navigateBack()},
})
