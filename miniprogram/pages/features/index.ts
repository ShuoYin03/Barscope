import { getThemeClass } from '../../utils/theme'

const FEATURES = [
  { id:'editorial-templates', category:'编辑模板', title:'Editorial Templates', subtitle:'REVIEW / FEATURE / INTERVIEW', status:'预览三套杂志化专题文章模板与 Block 排版系统', accent:'00', hero:true, cta:'预览' },
  { id:'2026-top-10', category:'年度企划', title:'2026 中文说唱十大专辑', subtitle:'开放投票中', status:'选出你的十张，写下理由，公开你的榜单', accent:'01', cta:'投票' },
  { id:'2026-best-newcomer', category:'年度企划', title:'2026 年度最佳新人', subtitle:'开放投票中', status:'从 2026 年发行首张 LP/Mixtape 的新人中选出你心中的三位', accent:'02', cta:'投票' },
  { id:'2026-top-reviewers', category:'年度企划', title:'2026 年度最常评分用户', subtitle:'实时统计中', status:'统计 2026 全年评论数据，看看谁在这一年留下了最多评分与乐评', accent:'03', cta:'查看' },
  { id:'long-review-template', category:'深度长评', title:'深度乐评征稿中', subtitle:'广告位等待投稿中…', status:'等待你的长篇乐评', accent:'04', cta:'投稿' },
  { id:'rapper-interview', category:'人物访谈', title:'Rapper 心里话', subtitle:'征集访谈投稿', status:'推荐或发起一次对话，写下完整访谈内容，审核通过后公开发布', accent:'05', cta:'查看' },
]

Page({
  data:{ statusBarHeight:20, topbarHeight:64, themeClass:'', features:FEATURES, filters:['全部','编辑模板','年度企划','深度长评','人物访谈'], activeFilter:'全部' },
  onLoad(){ const app=getApp<IAppOption>(); this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight}) },
  onShow(){ if(typeof this.getTabBar==='function') this.getTabBar()?.setData({selected:3}); this.setData({themeClass:getThemeClass()}) },
  onFilterTap(e:WechatMiniprogram.TouchEvent){ const value=String((e.currentTarget.dataset as any).value||'全部'); const features=value==='全部'?FEATURES:FEATURES.filter(x=>x.category===value); this.setData({activeFilter:value,features}) },
  onFeatureTap(e:WechatMiniprogram.TouchEvent){ const id=String((e.currentTarget.dataset as any).id||''); if(!id)return; if(id==='editorial-templates'){wx.navigateTo({url:'/pages/editorial-templates/index'});return} if(id==='2026-top-reviewers'){wx.navigateTo({url:'/pages/annual-reviewers/index'});return} if(id==='rapper-interview'){wx.navigateTo({url:'/pages/interviews/index'});return} wx.navigateTo({url:`/pages/feature-detail/index?id=${id}`}) }
})