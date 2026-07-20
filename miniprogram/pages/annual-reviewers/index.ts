import { getThemeClass } from '../../utils/theme'
import { trackFeatureView } from '../../utils/featureStats'

interface ReviewerRow { openId:string; nickName:string; avatarUrl:string; reviewCount:number; albumCount:number; avgRating:number; likesReceived:number; wordCount:number }

Page({
  data:{ statusBarHeight:20,topbarHeight:64,themeClass:'',loading:true,year:2026,totalReviews:0,totalReviewers:0,list:[] as ReviewerRow[] },
  onLoad(){ const app=getApp<IAppOption>(); this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight}); this.loadData(); trackFeatureView('2026-top-reviewers') },
  onShow(){ this.setData({themeClass:getThemeClass()}) },
  loadData(){
    this.setData({loading:true})
    wx.cloud.callFunction({name:'getAnnualReviewerLeaderboard',data:{year:2026,limit:100},success:(res:any)=>{
      const r=res.result||{}
      if(!r.success){wx.showToast({title:r.error||'加载失败',icon:'none'});this.setData({loading:false});return}
      this.setData({loading:false,year:r.year||2026,totalReviews:r.totalReviews||0,totalReviewers:r.totalReviewers||0,list:r.list||[]})
    },fail:()=>{this.setData({loading:false});wx.showToast({title:'加载失败',icon:'none'})}} as any)
  },
  onUserTap(e:WechatMiniprogram.TouchEvent){ const openId=String((e.currentTarget.dataset as any).openid||''); if(openId)wx.navigateTo({url:`/pages/user/index?openId=${encodeURIComponent(openId)}`}) },
  onBack(){wx.navigateBack()}
})
