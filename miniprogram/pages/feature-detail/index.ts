import { getThemeClass } from '../../utils/theme'

const ARTICLES:any = {
  '2026-top-10': { category:'年度企划', title:'2026 中文说唱十大专辑', author:'BEATWEEN EDITORIAL', date:'2026.12', readTime:'12 MIN', intro:'这不是一份只按热度排列的榜单。我们更关心：哪些作品真正完成了自己的声音，哪些专辑拓宽了中文说唱的表达边界。', sections:[
    { heading:'评选标准', body:'作品完整度、制作语言、叙事能力、场景影响与重复聆听价值，是这份榜单的五个核心维度。我们不把单曲热度直接等同于专辑质量。' },
    { heading:'为什么需要年度企划', body:'年度榜单的意义，不只是给作品排序，而是为这一年的声音留下坐标。它应该帮助听众重新理解被忽略的作品，也应该说明每一个判断背后的理由。' },
    { heading:'榜单即将发布', body:'正式榜单将包含十张专辑、每张作品的完整评语、推荐曲目与编辑部评分。' }
  ]},
  'long-review-template': { category:'深度长评', title:'一张专辑，如何留下自己的时代坐标', author:'编辑部', date:'2026.07', readTime:'8 MIN', intro:'真正有价值的乐评，不是把“喜欢”写得更长，而是建立一套能够被读者理解、讨论甚至反驳的判断。', sections:[
    { heading:'先回答作品想做什么', body:'评价一张专辑之前，先识别它的目标：它是在构建人物、记录场景、探索声音，还是完成一套概念。脱离作品目标的评价，往往只剩个人偏好。' },
    { heading:'把声音写具体', body:'不要只写“制作很好”。应该说明鼓组、采样、空间感、人声处理如何共同服务作品，以及这些选择是否形成了稳定的听觉语言。' },
    { heading:'判断必须有证据', body:'好的长评允许鲜明立场，但每一个结论都应回到歌词、编排、结构或文化语境。观点越强，证据越要具体。' }
  ]},
  'rapper-interview': { category:'人物访谈', title:'在作品之外，听见 Rapper 如何成为自己', author:'BEATWEEN CONVERSATIONS', date:'2026.07', readTime:'10 MIN', intro:'访谈不只是为新专辑做宣传。我们更想知道，一个 Rapper 如何形成自己的判断、声音与生活方式。', sections:[
    { heading:'从作品进入，但不止于作品', body:'我们会从一张专辑、一首歌或一次现场切入，再继续追问创作背后的经验、选择与犹豫。比起标准答案，我们更在意真实的思考过程。' },
    { heading:'让人物自己定义自己', body:'外界习惯用地域、厂牌、风格或热度概括一位 Rapper。人物访谈会把解释权交还给创作者，让他们谈清楚自己如何理解身份、野心与变化。' },
    { heading:'持续记录中文说唱的人物样本', body:'这个栏目将覆盖不同代际、地区与创作路径的 Rapper，也会延伸至制作人、DJ、厂牌主理人与现场组织者。' }
  ]}
}

Page({
  data:{statusBarHeight:20,topbarHeight:64,themeClass:'',article:null as any},
  onLoad(options:any){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight,article:ARTICLES[String(options.id||'')]||ARTICLES['2026-top-10']})},
  onShow(){this.setData({themeClass:getThemeClass()})},
  onBack(){wx.navigateBack()}
})
