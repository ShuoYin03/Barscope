import { getThemeClass } from '../../utils/theme'

type FeatureItem = {
  id: string
  category: string
  title: string
  subtitle: string
  status: string
  accent: string
  cta: string
  hero?: boolean
  isPinned?: boolean
  manualPriority?: number
  viewCount?: number
  participantCount?: number
  participantLabel?: string
  shareCount?: number
  heatScore?: number
  recentHeatScore?: number
}

const BASE_FEATURES: FeatureItem[] = [
  { id:'2026-h1-top-50-tracks', category:'榜单', title:'2026 上半年中文说唱 Top50 单曲', subtitle:'歌单征集中', status:'汇集中文说唱博主的上半年歌单，共同选出 2026 H1 最值得听的 50 首作品', accent:'01', hero:true, cta:'查看', manualPriority:100, viewCount:0, participantCount:0, participantLabel:'份歌单', shareCount:0, heatScore:0, recentHeatScore:0 },
  { id:'2026-top-10', category:'年度企划', title:'2026 中文说唱十大专辑', subtitle:'开放投票中', status:'选出你的十张，写下理由，公开你的榜单', accent:'02', cta:'投票', manualPriority:90, viewCount:0, participantCount:0, participantLabel:'人参与', shareCount:0, heatScore:0, recentHeatScore:0 },
  { id:'2026-best-newcomer', category:'年度企划', title:'2026 年度最佳新人', subtitle:'开放投票中', status:'从 2026 年发行首张 LP/Mixtape 的新人中选出你心中的三位', accent:'03', cta:'投票', manualPriority:80, viewCount:0, participantCount:0, participantLabel:'人参与', shareCount:0, heatScore:0, recentHeatScore:0 },
  { id:'2026-top-5-mixtapes', category:'年度企划', title:'2026 五大 Mixtape', subtitle:'开放投票中', status:'从 2026 年发行、类型已标记为 Mixtape 的项目中选出你心中的五张', accent:'04', cta:'投票', manualPriority:70, viewCount:0, participantCount:0, participantLabel:'人参与', shareCount:0, heatScore:0, recentHeatScore:0 },
  { id:'2026-top-reviewers', category:'年度企划', title:'2026 年度最常评分用户', subtitle:'实时统计中', status:'统计 2026 全年评论数据，看看谁在这一年留下了最多评分与乐评', accent:'05', cta:'查看', manualPriority:60, viewCount:0, participantCount:0, participantLabel:'人上榜', shareCount:0, heatScore:0, recentHeatScore:0 },
  { id:'long-review-template', category:'深度长评', title:'深度乐评征稿中', subtitle:'广告位等待投稿中…', status:'等待你的长篇乐评', accent:'06', cta:'投稿', manualPriority:50, viewCount:0, participantCount:0, participantLabel:'篇投稿', shareCount:0, heatScore:0, recentHeatScore:0 },
  { id:'rapper-interview', category:'人物访谈', title:'Rapper 心里话', subtitle:'征集访谈投稿', status:'推荐或发起一次对话，写下完整访谈内容，审核通过后公开发布', accent:'07', cta:'查看', manualPriority:40, viewCount:0, participantCount:0, participantLabel:'篇访谈', shareCount:0, heatScore:0, recentHeatScore:0 },
]

function formatMetric(value: number) {
  const n = Number(value || 0)
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}W`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`
  return String(n)
}

function calculateHeat(item: FeatureItem) {
  const views = Number(item.viewCount || 0)
  const participants = Number(item.participantCount || 0)
  const shares = Number(item.shareCount || 0)
  const recent = Number(item.recentHeatScore || 0)
  return Math.round(views + participants * 15 + shares * 12 + recent * 2)
}

function decorate(items: FeatureItem[]) {
  return items.map(item => {
    const heatScore = Number(item.heatScore || calculateHeat(item))
    return {
      ...item,
      heatScore,
      viewDisplay: formatMetric(Number(item.viewCount || 0)),
      participantDisplay: formatMetric(Number(item.participantCount || 0)),
      shareDisplay: formatMetric(Number(item.shareCount || 0)),
      heatDisplay: formatMetric(heatScore),
    }
  })
}

function sortFeatures(items: FeatureItem[]) {
  return items.slice().sort((a, b) => {
    if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1
    const priorityDiff = Number(b.manualPriority || 0) - Number(a.manualPriority || 0)
    if (priorityDiff) return priorityDiff
    const recentDiff = Number(b.recentHeatScore || 0) - Number(a.recentHeatScore || 0)
    if (recentDiff) return recentDiff
    return Number(b.heatScore || calculateHeat(b)) - Number(a.heatScore || calculateHeat(a))
  })
}

Page({
  data:{ statusBarHeight:20, topbarHeight:64, themeClass:'', features:decorate(sortFeatures(BASE_FEATURES)), allFeatures:decorate(sortFeatures(BASE_FEATURES)), filters:['全部','榜单','年度企划','深度长评','人物访谈'], activeFilter:'全部' },
  onLoad(){
    const app=getApp<IAppOption>()
    this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight})
    this._loadFeatureMetrics()
  },
  onShow(){ if(typeof this.getTabBar==='function') this.getTabBar()?.setData({selected:3}); this.setData({themeClass:getThemeClass()}) },
  _loadFeatureMetrics(){
    wx.cloud.callFunction({
      name:'manageFeaturePlaylists',
      data:{action:'list_public'},
      success:(res:any)=>{
        const r=res.result||{}
        if(!r.success)return
        const playlistCount=Number(r.editorialCount||0)+Number(r.communityCount||0)
        const updated=BASE_FEATURES.map(item=>item.id==='2026-h1-top-50-tracks'?{...item,participantCount:playlistCount}:item)
        const allFeatures=decorate(sortFeatures(updated))
        const activeFilter=this.data.activeFilter
        this.setData({allFeatures,features:activeFilter==='全部'?allFeatures:allFeatures.filter((x:any)=>x.category===activeFilter)})
      },
    } as any)
  },
  onFilterTap(e:WechatMiniprogram.TouchEvent){ const value=String((e.currentTarget.dataset as any).value||'全部'); const allFeatures=this.data.allFeatures as any[]; const features=value==='全部'?allFeatures:allFeatures.filter(x=>x.category===value); this.setData({activeFilter:value,features}) },
  onFeatureTap(e:WechatMiniprogram.TouchEvent){ const id=String((e.currentTarget.dataset as any).id||''); if(!id)return; if(id==='2026-h1-top-50-tracks'){wx.navigateTo({url:'/pages/h1-top50/index'});return} if(id==='2026-top-reviewers'){wx.navigateTo({url:'/pages/annual-reviewers/index'});return} if(id==='rapper-interview'){wx.navigateTo({url:'/pages/interviews/index'});return} wx.navigateTo({url:`/pages/feature-detail/index?id=${id}`}) }
})