import { getThemeClass } from '../../utils/theme'

Page({
  data:{
    statusBarHeight:20,themeClass:'',
    openId:'',loading:true,loadError:'',
    nickName:'',avatarUrl:'',coverUrl:'',bio:'',isCritic:false,isAdmin:false,
    reviewCount:0,likesReceived:0,followerCount:0,followingCount:0,
    isMe:false,isFollowing:false,followBusy:false,
    latestReviews:[] as any[],
    badges:[] as any[],
  },
  onLoad(options){
    const app=getApp<IAppOption>()
    this.setData({statusBarHeight:app.globalData.statusBarHeight,openId:options.openId||''})
  },
  onShow(){
    this.setData({themeClass:getThemeClass()})
    if(this.data.openId)this.loadProfile()
  },
  loadProfile(){
    this.setData({loading:true,loadError:''})
    wx.cloud.callFunction({name:'getUserProfile',data:{openId:this.data.openId},success:(res:any)=>{
      const r=res.result||{}
      if(!r.success){this.setData({loading:false,loadError:r.error||'加载失败'});return}
      const p=r.profile||{}
      this.setData({
        loading:false,
        nickName:p.nickName||'匿名用户',
        avatarUrl:p.avatarUrl||'',
        coverUrl:p.coverUrl||'',
        bio:p.bio||'',
        isCritic:p.type==='critic',
        isAdmin:p.type==='admin',
        reviewCount:p.reviewCount||0,
        likesReceived:p.likesReceived||0,
        followerCount:p.followerCount||0,
        followingCount:p.followingCount||0,
        isMe:!!p.isMe,
        isFollowing:!!p.isFollowing,
        latestReviews:(p.latestReviews||[]).map((x:any)=>({...x,ratingText:x.rating?Number(x.rating).toFixed(1):'—'})),
        badges:p.badges||[],
      })
    },fail:()=>this.setData({loading:false,loadError:'加载失败，请确认云函数已部署'})} as any)
  },
  onToggleFollow(){
    if(this.data.isMe||this.data.followBusy)return
    const app=getApp<IAppOption>()
    if(!app.globalData.userInfo){wx.navigateTo({url:'/pages/login/index'});return}
    const wasFollowing=this.data.isFollowing
    this.setData({followBusy:true,isFollowing:!wasFollowing,followerCount:this.data.followerCount+(wasFollowing?-1:1)})
    wx.cloud.callFunction({name:'follows',data:{action:'toggle',openId:this.data.openId},success:(res:any)=>{
      const r=res.result||{}
      this.setData({followBusy:false})
      if(!r.success){this.setData({isFollowing:wasFollowing,followerCount:this.data.followerCount+(wasFollowing?1:-1)});wx.showToast({title:r.error||'操作失败',icon:'none'})}
    },fail:()=>{this.setData({followBusy:false,isFollowing:wasFollowing,followerCount:this.data.followerCount+(wasFollowing?1:-1)});wx.showToast({title:'网络错误',icon:'none'})}} as any)
  },
  onEditProfile(){wx.navigateTo({url:'/pages/login/index'})},
  onViewAllBadges(){wx.navigateTo({url:`/pages/badges/index?openId=${this.data.openId}`})},
  onReviewTap(e:WechatMiniprogram.TouchEvent){
    const albumId=(e.currentTarget.dataset as any).albumId
    if(albumId)wx.navigateTo({url:`/pages/album-detail/index?id=${albumId}`})
  },
  onBack(){wx.navigateBack()},
})
