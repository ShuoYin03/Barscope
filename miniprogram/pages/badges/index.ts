import { getThemeClass } from '../../utils/theme'

const BADGE_CATALOG = [
  { id:'first_review', category:'review', name:'落笔成章', icon:'✎', desc:'发布第 1 条乐评' },
  { id:'ten_reviews', category:'review', name:'十评俱全', icon:'✎✎', desc:'累计发布 10 条乐评' },
  { id:'fifty_reviews', category:'review', name:'字字珠玑', icon:'★', desc:'累计发布 50 条乐评' },
  { id:'hundred_reviews', category:'review', name:'评论成瘾', icon:'✦', desc:'累计发布 100 条乐评' },

  { id:'five_reviews', category:'taste', name:'初探声场', icon:'◌', desc:'累计发布 5 条乐评' },
  { id:'twentyfive_reviews', category:'taste', name:'掘金者', icon:'◇', desc:'累计发布 25 条乐评' },
  { id:'seventyfive_reviews', category:'taste', name:'深巷寻声', icon:'◎', desc:'累计发布 75 条乐评' },

  { id:'ten_likes', category:'community', name:'初有回声', icon:'♥', desc:'累计获得 10 个赞' },
  { id:'fifty_likes', category:'community', name:'回声扩大', icon:'♥♥', desc:'累计获得 50 个赞' },
  { id:'twohundred_likes', category:'community', name:'意见领唱', icon:'✺', desc:'累计获得 200 个赞' },
  { id:'ten_followers', category:'community', name:'圈内熟脸', icon:'⌁', desc:'获得 10 位关注者' },
  { id:'fifty_followers', category:'community', name:'风向标', icon:'⌁⌁', desc:'获得 50 位关注者' },
]

const CATEGORY_DEFS = [
  { key:'review', title:'评论成长', subtitle:'REVIEW JOURNEY' },
  { key:'taste', title:'品味探索', subtitle:'TASTE EXPLORATION' },
  { key:'community', title:'社区影响力', subtitle:'COMMUNITY IMPACT' },
]

function withoutProgress() {
  return BADGE_CATALOG.map(b => ({ ...b, hasProgress:false, current:0, target:0, pct:0, earned:false }))
}

function buildSections(badges:any[]) {
  return CATEGORY_DEFS.map(category => ({
    ...category,
    badges: badges.filter(b => b.category === category.key),
  }))
}

Page({
  data:{
    statusBarHeight:20,themeClass:'',
    openId:'',nickName:'',
    badges:withoutProgress() as any[],
    sections:buildSections(withoutProgress()) as any[],
    hasEarnedCount:false,earnedCount:0,
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
      this.setData({
        nickName:r.profile.nickName||'',
        badges,
        sections:buildSections(badges),
        hasEarnedCount:true,
        earnedCount:badges.filter((b:any)=>b.earned).length,
      })
    }} as any)
  },
  onBack(){wx.navigateBack()},
})
