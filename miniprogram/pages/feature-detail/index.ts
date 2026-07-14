import { getThemeClass } from '../../utils/theme'

const ARTICLES:any = {
  '2026-top-10': { category:'年度企划', title:'2026 中文说唱十大专辑', author:'等待投稿中…', date:'', readTime:'', intro:'本栏目等待投稿中。欢迎提交你的年度十佳名单、完整评选理由与每张专辑的推荐语。', sections:[
    { heading:'投稿方向', body:'围绕 2026 年中文说唱专辑展开评选，可以提交个人榜单、联合榜单或完整年度观察。' },
    { heading:'建议内容', body:'请尽量说明评选标准，并为入选专辑提供清晰、具体、可讨论的判断。' },
    { heading:'等待投稿中…', body:'广告位等待投稿中…' }
  ]},
  'long-review-template': { category:'深度长评', title:'深度乐评征稿中', author:'等待投稿中…', date:'', readTime:'', intro:'广告位等待投稿中…', sections:[
    { heading:'投稿方向', body:'欢迎提交专辑长评、单曲分析、制作解析、歌词解读或其他有明确观点的深度乐评。' },
    { heading:'内容要求', body:'不限制立场，但希望观点清楚、论据具体，并尽量回到作品本身。' },
    { heading:'等待投稿中…', body:'把你真正想写的那篇乐评放到这里。' }
  ]},
  'rapper-interview': { category:'人物访谈', title:'Rapper 心里话', author:'等待投稿中…', date:'', readTime:'', intro:'广告位等待投稿中…', sections:[
    { heading:'投稿方向', body:'欢迎提交 Rapper 访谈、人物故事、创作对谈与幕后记录。' },
    { heading:'我们想看到', body:'不只聊新歌和宣传，也聊成长、选择、困惑、野心，以及作品之外真实的人。' },
    { heading:'等待投稿中…', body:'把 Rapper 真正想说的话留在这里。' }
  ]}
}

Page({
  data:{statusBarHeight:20,topbarHeight:64,themeClass:'',article:null as any},
  onLoad(options:any){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight,article:ARTICLES[String(options.id||'')]||ARTICLES['2026-top-10']})},
  onShow(){this.setData({themeClass:getThemeClass()})},
  onBack(){wx.navigateBack()}
})