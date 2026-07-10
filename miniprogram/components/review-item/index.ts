Component({
  properties: { review: { type: Object, value: null }, showAlbum: { type: Boolean, value: false } },
  data: { localLiked: false, liking: false, hidden: false },
  observers: { review(review: any) { this.setData({ localLiked: !!review?.likedByMe, liking: false, hidden: false }) } },
  methods: {
    onTap() { this.triggerEvent('tap', { review: this.properties.review }) },
    onLike() { const review=this.properties.review as any;if(!review||this.data.localLiked||this.data.liking)return;this.setData({localLiked:true,liking:true});this.triggerEvent('like',{reviewId:review._id}) },
    onReply() { const review=this.properties.review as any;this.triggerEvent('reply',{reviewId:review&&review._id,userName:review&&review.userName}) },
    onManage() {
      const review=this.properties.review as any;if(!review||!review._id)return
      wx.showActionSheet({itemList:['删除我的评论','举报不当言论'],success:(s:any)=>{
        if(s.tapIndex===0)this.deleteMine(review._id)
        else this.reportReview(review._id)
      }})
    },
    deleteMine(reviewId:string){wx.showModal({title:'删除这条评论？',content:'删除后无法恢复。',confirmText:'删除',confirmColor:'#C94E25',success:(m:any)=>{if(!m.confirm)return;wx.cloud.callFunction({name:'reviewModeration',data:{action:'deleteMine',reviewId},success:(r:any)=>{const x=r.result||{};if(x.success){this.setData({hidden:true});wx.showToast({title:'已删除',icon:'success'});this.triggerEvent('changed',{reviewId,action:'deleted'})}else wx.showToast({title:x.error||'删除失败',icon:'none'})},fail:()=>wx.showToast({title:'删除失败',icon:'none'})} as any)}})},
    reportReview(reviewId:string){wx.showModal({title:'举报评论',editable:true,placeholderText:'请填写举报原因，例如：辱骂、广告、歧视内容',confirmText:'提交',confirmColor:'#C94E25',success:(m:any)=>{if(!m.confirm)return;wx.cloud.callFunction({name:'reviewModeration',data:{action:'report',reviewId,reason:String(m.content||'不当言论').trim()},success:(r:any)=>{const x=r.result||{};wx.showToast({title:x.success?(x.existed?'已举报过':'举报成功'):(x.error||'举报失败'),icon:'none'})},fail:()=>wx.showToast({title:'举报失败',icon:'none'})} as any)}})},
  },
})