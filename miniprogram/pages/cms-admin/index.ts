import { getThemeClass } from '../../utils/theme'

Page({
  data:{
    statusBarHeight:20,
    topbarHeight:64,
    themeClass:'',
    reviewCount:0,
    albumCount:0,
    healthLabel:'DATA HEALTH',
    loading:true,
  },
  onLoad(){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight})},
  onShow(){this.setData({themeClass:getThemeClass()});this.loadStats()},
  onBack(){wx.navigateBack()},
  loadStats(){
    this.setData({loading:true})
    let pending=0,albumPending=0,ownership=0,typePending=0,reports=0,tracks=0
    const finish=()=>this.setData({reviewCount:pending+reports+tracks,albumCount:albumPending+ownership+typePending,loading:false})
    Promise.all([
      wx.cloud.callFunction({name:'manageCandidates',data:{action:'stats'}}).then((r:any)=>{pending=Number(r.result?.pending||0)}).catch(()=>{}),
      wx.cloud.callFunction({name:'manageAlbumCandidates',data:{action:'stats'}}).then((r:any)=>{albumPending=Number(r.result?.pending||0)}).catch(()=>{}),
      wx.cloud.callFunction({name:'manageAlbumOwnershipCorrections',data:{action:'stats'}}).then((r:any)=>{ownership=Number(r.result?.pending||0)}).catch(()=>{}),
      wx.cloud.callFunction({name:'manageAlbumTypeCorrections',data:{action:'stats'}}).then((r:any)=>{typePending=Number(r.result?.pending||0)}).catch(()=>{}),
      wx.cloud.callFunction({name:'reviewModeration',data:{action:'stats'}}).then((r:any)=>{reports=Number(r.result?.pending||0)}).catch(()=>{}),
      wx.cloud.callFunction({name:'manageTrackCorrections',data:{action:'stats'}}).then((r:any)=>{tracks=Number(r.result?.pending||0)}).catch(()=>{}),
    ]).then(finish).catch(finish)
  },
  go(e:WechatMiniprogram.TouchEvent){const url=String((e.currentTarget.dataset as any).url||'');if(url)wx.navigateTo({url})},
})
