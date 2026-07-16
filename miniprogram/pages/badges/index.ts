import { getThemeClass } from '../../utils/theme'

// Static catalog — mirrors cloudfunctions/getUserProfile's BADGE_DEFS (name/icon/desc must stay
// in sync). Rendered immediately regardless of network state so the page is never blank; live
// progress (current/target/earned) is merged in once getUserProfile responds, falling back to
// an "in development" note per badge if that data isn't available yet.
const BADGE_CATALOG = [
  { id:'first_review', name:'落笔成章', icon:'✎', desc:'留下你的第一段声音' },
  { id:'ten_reviews', name:'十评俱全', icon:'✎✎', desc:'累计发布 10 条乐评，开始形成自己的判断' },
  { id:'fifty_reviews', name:'字字珠玑', icon:'★', desc:'累计发布 50 条乐评，让观点成为风格' },
  { id:'ten_likes', name:'初有回声', icon:'♥', desc:'乐评累计获得 10 个赞，开始有人听见你的声音' },
  { id:'fifty_likes', name:'回声扩大', icon:'♥♥', desc:'乐评累计获得 50 个赞，你的观点正在扩散' },
  { id:'ten_followers', name:'圈内熟脸', icon:'⌁', desc:'吸引 10 位关注者，开始有人等你开口' },
]
function withoutProgress() {
  return BADGE_CATALOG.map(b => ({ ...b, hasProgress:false, current:0, target:0, pct:0, earned:false }))
}

Page({
  data:{
    statusBarHeight:20,themeClass:'',
    openId:'',nickName:'',
    badges:withoutProgress() as any[],hasEarnedCount:false,earnedCount:0,
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
    wx.cloud.callFunction({name:'getUserProfile',data:{openId:this.data.openId},success:(res:any)=>{
      const r=res.result||{}
      const liveBadges:any[]=(r.success&&Array.isArray(r.profile?.badges))?r.profile.badges:[]
      if(!liveBadges.length)return
      const liveMap=new Map(liveBadges.map((b:any)=>[b.id,b]))
      const badges=BADGE_CATALOG.map(b=>{
        const live=liveMap.get(b.id) as any
        if(!live)return {...b,hasProgress:false,current:0,target:0,pct:0,earned:false}
        return {...b,hasProgress:true,current:live.current,target:live.target,earned:live.earned,pct:live.target?Math.round((live.current/live.target)*100):0}
      })
      this.setData({nickName:r.profile.nickName||'',badges,hasEarnedCount:true,earnedCount:badges.filter((b:any)=>b.earned).length})
    }} as any)
  },
  onBack(){wx.navigateBack()},
})