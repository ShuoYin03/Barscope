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
  'scene-report': { category:'场景企划', title:'城市、厂牌与下一轮中文说唱版图', author:'BEATWEEN RESEARCH', date:'2026.07', readTime:'10 MIN', intro:'城市标签从来不只是籍贯。它背后包含演出网络、制作人协作、厂牌组织与听众社群。', sections:[
    { heading:'热度不等于场景', body:'一个地区拥有爆款艺人，不代表已经形成稳定场景。真正的场景需要持续的新作品、线下空间、跨艺人协作与本地听众基础。' },
    { heading:'厂牌的角色正在变化', body:'厂牌不再只是发行单位，也可能承担内容策划、视觉系统、演出组织与新人培养。它们是否能建立长期机制，比短期签约数量更重要。' },
    { heading:'我们将持续追踪', body:'专题将逐步覆盖城市样本、厂牌案例、现场演出与制作人网络，并形成可持续更新的中文说唱场景档案。' }
  ]}
}

Page({
  data:{statusBarHeight:20,topbarHeight:64,themeClass:'',article:null as any},
  onLoad(options:any){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight,article:ARTICLES[String(options.id||'')]||ARTICLES['2026-top-10']})},
  onShow(){this.setData({themeClass:getThemeClass()})},
  onBack(){wx.navigateBack()}
})