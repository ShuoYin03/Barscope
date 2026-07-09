Page({
  data:{statusBarHeight:20,list:[] as any[],loading:true,loadError:''},
  onLoad(){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight});this.loadReports()},
  onShow(){this.loadReports()},
  loadReports(){this.setData({loading:true,loadError:''});wx.cloud.callFunction({name:'manageCrawlerReports',data:{action:'list'},success:(res:any)=>{const r=res.result||{};if(!r.success){this.setData({loading:false,loadError:r.error||'加载失败'});return}this.setData({list:r.list||[],loading:false})},fail:()=>this.setData({loading:false,loadError:'加载失败，请确认云函数已部署'})} as any)},
  onBack(){wx.navigateBack()}
})
