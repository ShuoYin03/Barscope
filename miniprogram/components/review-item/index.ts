const CLAMP_LENGTH = 60

Component({
  properties: { review: { type: Object, value: null }, showAlbum: { type: Boolean, value: false } },
  data: { localLiked: false, liking: false, hidden: false, expanded: false, hasLongContent: false, reportSheetVisible: false, reportReviewId: '', reportReason: '', reportSubmitting: false },
  observers: {
    review(review: any) {
      const content = String((review && review.content) || '')
      this.setData({ localLiked: !!review?.likedByMe, liking: false, hidden: false, expanded: false, hasLongContent: content.length > CLAMP_LENGTH })
    },
  },
  methods: {
    onTap() { this.triggerEvent('tap', { review: this.properties.review }) },
    onToggleExpand() { if (!this.data.hasLongContent) return; this.setData({ expanded: !this.data.expanded }) },
    onLike() { const review=this.properties.review as any;if(!review||this.data.localLiked||this.data.liking)return;this.setData({localLiked:true,liking:true});this.triggerEvent('like',{reviewId:review._id}) },
    onReply() { const review=this.properties.review as any;this.triggerEvent('reply',{reviewId:review&&review._id,userName:review&&review.userName}) },
    onManage() {
      const review=this.properties.review as any;if(!review||!review._id)return
      wx.showActionSheet({itemList:['删除我的评论','举报不当言论'],success:(s:any)=>{
        if(s.tapIndex===0)this.deleteMine(review._id)
        else this.openReportSheet(review._id)
      }})
    },
    deleteMine(reviewId:string){wx.showModal({title:'删除这条评论？',content:'删除后无法恢复。',confirmText:'删除',confirmColor:'#C94E25',success:(m:any)=>{if(!m.confirm)return;wx.cloud.callFunction({name:'reviewModeration',data:{action:'deleteMine',reviewId},success:(r:any)=>{const x=r.result||{};if(x.success){this.setData({hidden:true});wx.showToast({title:'已删除',icon:'success'});this.triggerEvent('changed',{reviewId,action:'deleted'})}else wx.showToast({title:x.error||'删除失败',icon:'none'})},fail:()=>wx.showToast({title:'删除失败',icon:'none'})} as any)}})},
    openReportSheet(reviewId:string){this.setData({reportSheetVisible:true,reportReviewId:reviewId,reportReason:''})},
    onReportReasonInput(e:WechatMiniprogram.Input){this.setData({reportReason:e.detail.value||''})},
    onReportCancel(){if(!this.data.reportSubmitting)this.setData({reportSheetVisible:false})},
    onReportSubmit(){
      const reviewId=this.data.reportReviewId
      if(!reviewId||this.data.reportSubmitting)return
      this.setData({reportSubmitting:true})
      wx.cloud.callFunction({name:'reviewModeration',data:{action:'report',reviewId,reason:String(this.data.reportReason||'').trim()||'不当言论'},success:(r:any)=>{
        this.setData({reportSubmitting:false})
        const x=r.result||{}
        if(x.success){this.setData({reportSheetVisible:false});wx.showToast({title:x.existed?'已举报过':'举报成功',icon:'none'})}
        else wx.showToast({title:x.error||'举报失败',icon:'none'})
      },fail:()=>{this.setData({reportSubmitting:false});wx.showToast({title:'举报失败',icon:'none'})}} as any)
    },
    noop(){},
  },
})