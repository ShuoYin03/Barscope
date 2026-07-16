import { getThemeClass } from '../../utils/theme'

const FEATURES = [
  { id:'2026-top-10', category:'年度企划', title:'2026 中文说唱十大专辑', subtitle:'开放投票中', status:'选出你的十张，写下理由，公开你的榜单', accent:'01', hero:true, cta:'投票' },
  { id:'long-review-template', category:'深度长评', title:'深度乐评征稿中', subtitle:'广告位等待投稿中…', status:'等待你的长篇乐评', accent:'02', cta:'投稿' },
  { id:'rapper-interview', category:'人物访谈', title:'Rapper 心里话', subtitle:'广告位等待投稿中…', status:'等待你的采访与人物故事', accent:'03', cta:'投稿' },
]

Page({
  data:{ statusBarHeight:20, topbarHeight:64, themeClass:'', features:FEATURES, filters:['全部','年度企划','深度长评','人物访谈'], activeFilter:'全部' },
  onLoad(){ const app=getApp<IAppOption>(); this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight}) },
  onShow(){ if(typeof this.getTabBar==='function') this.getTabBar()?.setData({selected:3}); this.setData({themeClass:getThemeClass()}) },
  onFilterTap(e:WechatMiniprogram.TouchEvent){ const value=String((e.currentTarget.dataset as any).value||'全部'); const features=value==='全部'?FEATURES:FEATURES.filter(x=>x.category===value); this.setData({activeFilter:value,features}) },
  onFeatureTap(e:WechatMiniprogram.TouchEvent){ const id=String((e.currentTarget.dataset as any).id||''); if(id) wx.navigateTo({url:`/pages/feature-detail/index?id=${id}`}) }
})