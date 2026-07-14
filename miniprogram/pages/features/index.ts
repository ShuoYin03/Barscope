import { getThemeClass } from '../../utils/theme'

const FEATURES = [
  { id:'2026-top-10', category:'年度企划', title:'2026 中文说唱十大专辑', subtitle:'从作品完整度、声音突破与场景影响出发，重看这一年的十张关键唱片。', author:'BEATWEEN EDITORIAL', date:'2026.12', readTime:'12 MIN', accent:'01', hero:true },
  { id:'long-review-template', category:'深度长评', title:'一张专辑，如何留下自己的时代坐标', subtitle:'从叙事、制作与地域语境三个维度，拆解一篇真正有判断的长篇乐评。', author:'编辑部', date:'2026.07', readTime:'8 MIN', accent:'02' },
  { id:'scene-report', category:'场景企划', title:'城市、厂牌与下一轮中文说唱版图', subtitle:'不只看热度，也看社群、演出与持续产出的结构性变化。', author:'BEATWEEN RESEARCH', date:'2026.07', readTime:'10 MIN', accent:'03' },
]

Page({
  data:{ statusBarHeight:20, topbarHeight:64, themeClass:'', features:FEATURES, filters:['全部','年度企划','深度长评','场景企划'], activeFilter:'全部' },
  onLoad(){ const app=getApp<IAppOption>(); this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight}) },
  onShow(){ if(typeof this.getTabBar==='function') this.getTabBar()?.setData({selected:3}); this.setData({themeClass:getThemeClass()}) },
  onFilterTap(e:WechatMiniprogram.TouchEvent){ const value=String((e.currentTarget.dataset as any).value||'全部'); const features=value==='全部'?FEATURES:FEATURES.filter(x=>x.category===value); this.setData({activeFilter:value,features}) },
  onFeatureTap(e:WechatMiniprogram.TouchEvent){ const id=String((e.currentTarget.dataset as any).id||''); if(id) wx.navigateTo({url:`/pages/feature-detail/index?id=${id}`}) }
})