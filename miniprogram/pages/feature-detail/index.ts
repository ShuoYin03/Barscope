import { getThemeClass } from '../../utils/theme'

const ARTICLES:any = {
  '2026-top-10': {
    category:'年度企划',
    title:'2026 中文说唱十大专辑',
    intro:'提交你的年度十佳名单、评选思路或完整企划。留下微信号，编辑部会联系合适的投稿者进一步讨论。',
    proposalPlaceholder:'例如：我的 2026 中文说唱十大专辑（地下向）',
    ideaPlaceholder:'介绍你的评选思路、判断标准，以及这份企划和其他年度榜单有什么不同。',
    outlinePlaceholder:'可以列出初步专辑名单、文章结构或合作方式。',
  },
  'long-review-template': {
    category:'深度长评',
    title:'深度乐评征稿中',
    intro:'告诉我们你想写哪张专辑、为什么值得写，以及你准备从什么角度展开。留下微信号，编辑部会与你详谈。',
    proposalPlaceholder:'例如：《专辑名》深度乐评',
    ideaPlaceholder:'写下你的核心观点、切入角度，以及为什么这张专辑值得被认真讨论。',
    outlinePlaceholder:'可以列出文章大纲、重点曲目或已有样稿。',
  },
  'rapper-interview': {
    category:'人物访谈',
    title:'Rapper 心里话',
    intro:'可以推荐采访对象，也可以由 Rapper、Producer、DJ 或厂牌成员本人发起。写下想聊的话题，并留下微信号详谈。',
    proposalPlaceholder:'例如：和 XXX 聊聊作品之外的生活',
    ideaPlaceholder:'介绍采访对象、想聊的主题，以及为什么这次对话值得被记录。',
    outlinePlaceholder:'可以列出问题方向、采访形式或已确认的嘉宾信息。',
  },
}

Page({
  data:{
    statusBarHeight:20,
    topbarHeight:64,
    themeClass:'',
    featureId:'',
    article:null as any,
    proposalTitle:'',
    idea:'',
    outline:'',
    wechat:'',
    links:'',
    submitting:false,
  },

  onLoad(options:any){
    const app=getApp<IAppOption>()
    const featureId=String(options.id||'2026-top-10')
    this.setData({
      statusBarHeight:app.globalData.statusBarHeight,
      topbarHeight:app.globalData.topbarHeight,
      featureId,
      article:ARTICLES[featureId]||ARTICLES['2026-top-10'],
    })
  },

  onShow(){this.setData({themeClass:getThemeClass()})},

  onFieldInput(e:WechatMiniprogram.Input|WechatMiniprogram.TextareaInput){
    const field=String((e.currentTarget.dataset as any).field||'')
    if(!field)return
    this.setData({[field]:e.detail.value||''} as any)
  },

  onSubmit(){
    if(this.data.submitting)return
    const proposalTitle=this.data.proposalTitle.trim()
    const idea=this.data.idea.trim()
    const wechat=this.data.wechat.trim()
    if(proposalTitle.length<2){wx.showToast({title:'请填写项目标题',icon:'none'});return}
    if(idea.length<30){wx.showToast({title:'项目想法至少 30 字',icon:'none'});return}
    if(wechat.length<3){wx.showToast({title:'请填写微信号',icon:'none'});return}

    wx.showModal({
      title:'提交企划？',
      content:'提交后，编辑部将通过你留下的微信号联系。内容不会公开展示。',
      confirmText:'确认提交',
      confirmColor:'#D45124',
      success:(modal)=>{
        if(!modal.confirm)return
        this.setData({submitting:true})
        wx.showLoading({title:'提交中…',mask:true})
        wx.cloud.callFunction({
          name:'submitFeatureProposal',
          data:{
            featureId:this.data.featureId,
            featureTitle:this.data.article.title,
            category:this.data.article.category,
            proposalTitle,
            idea,
            outline:this.data.outline.trim(),
            wechat,
            links:this.data.links.trim(),
          },
          success:(res:any)=>{
            const result=res.result||{}
            if(!result.success){wx.showToast({title:result.error||'提交失败',icon:'none'});return}
            this.setData({proposalTitle:'',idea:'',outline:'',wechat:'',links:''})
            wx.showToast({title:'企划已提交',icon:'success'})
          },
          fail:()=>wx.showToast({title:'网络错误，请重试',icon:'none'}),
          complete:()=>{wx.hideLoading();this.setData({submitting:false})},
        } as any)
      },
    })
  },

  onBack(){wx.navigateBack()},
})
