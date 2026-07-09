interface ProfileReview {
  _id: string
  albumId: string
  albumTitle: string
  ratingText: string
  content: string
  timeAgo: string
  likes: number
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    isLoggedIn: false,
    userInfo: null as IAppOption['globalData']['userInfo'],
    isCritic: false,
    isAdmin: false,
    pendingCount: 0,
    favCount: 0,
    albumCount: 0,
    reviews: [] as ProfileReview[],
    loading: false,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
  },

  onShow() {
    if (typeof this.getTabBar === 'function') this.getTabBar()?.setData({ selected: 4 })
    const app = getApp<IAppOption>()
    const loggedIn = !!app.globalData.userInfo
    this.setData({ isLoggedIn: loggedIn, userInfo: app.globalData.userInfo, isCritic: app.globalData.userType === 'critic' })
    if (loggedIn) this._loadReviews()
  },

  _loadReviews() {
    this.setData({ loading: true })
    wx.cloud.callFunction({
      name: 'getUserInfo',
      success: (res: any) => {
        const result = res.result
        if (!result.success) { this.setData({ loading: false }); return }
        const app = getApp<IAppOption>(), user = result.user
        app.globalData.userInfo = { openId:user.openId, nickName:user.nickName, avatarUrl:user.avatarUrl || '', type:user.type, bio:user.bio || '', reviewCount:user.reviewCount || 0 }
        app.globalData.userType = user.type
        app.globalData.isAdmin = user.type === 'admin'
        const isAdmin = user.type === 'admin'
        this.setData({ userInfo:app.globalData.userInfo, isCritic:user.type === 'critic', isAdmin })
        if (isAdmin) this._loadPendingCount()
        wx.cloud.callFunction({ name:'getReviews', data:{ userId:user.openId, pageSize:20 }, success:(r:any)=>{
          const rv=r.result
          const list=(rv.list || []).map((item:any)=>({_id:item._id,albumId:item.albumId,albumTitle:item.albumTitle || item.albumId,ratingText:'★'.repeat(item.rating || 0),content:item.content,timeAgo:item.timeAgo || '',likes:item.likes || 0}))
          this.setData({ reviews:list, albumCount:new Set(list.map((x:ProfileReview)=>x.albumId)).size, loading:false })
        }, fail:()=>this.setData({loading:false}) })
        wx.cloud.callFunction({ name:'getFavorites', data:{}, success:(fr:any)=>{if(fr.result?.success)this.setData({favCount:(fr.result.list || []).length})} } as any)
      },
      fail: () => this.setData({ loading: false }),
    })
  },

  _loadPendingCount() { wx.cloud.callFunction({ name:'manageCandidates',data:{action:'stats'},success:(res:any)=>{const r=res.result;if(r.success)this.setData({pendingCount:r.pending || 0})} }) },
  onAdminCandidates() { wx.navigateTo({ url:'/pages/admin/index' }) },
  onAdminAlbums() { wx.navigateTo({ url:'/pages/album-manager/index' }) },
  onAdminCrawler() { wx.navigateTo({ url:'/pages/crawler/index' }) },
  onAdminCritics() { wx.navigateTo({ url:'/pages/critics/index' }) },
  onMyReviews() { wx.showToast({ title:'评论页面开发中', icon:'none' }) },
  onMyFavorites() { wx.switchTab({ url:'/pages/favorites/index' }) },
  onSettingsTap() { wx.showToast({ title:'设置开发中', icon:'none' }) },
  onLogin() { wx.navigateTo({ url:'/pages/login/index' }) },
  onReviewTap(e:WechatMiniprogram.TouchEvent) { const id=(e.currentTarget.dataset as {id:string}).id;if(id)wx.navigateTo({url:`/pages/album-detail/index?id=${id}`}) },

  onSubmitArtistRequest() {
    wx.showModal({ title:'提交 rapper 申请', editable:true, placeholderText:'输入网易云 rapper 名称', confirmText:'提交审核', success:(modal:any)=>{
      const name=String(modal.content || '').trim()
      if (!modal.confirm || !name) return
      wx.showLoading({ title:'正在查询网易云…', mask:true })
      wx.cloud.callFunction({
        name:'submitArtistRequest', data:{ name },
        success:(res:any)=>{
          wx.hideLoading()
          const r=res.result || {}
          if (!r.success) { wx.showToast({ title:r.error || '提交失败', icon:'none' }); return }
          if (r.existed) {
            const text=r.status === 'approved' ? '该 rapper 已收录' : r.status === 'pending' ? '该 rapper 已在审核中' : '该 rapper 已有审核记录'
            wx.showToast({ title:text, icon:'none' })
            return
          }
          wx.showToast({ title:`已提交 ${r.artistName}`, icon:'success' })
        },
        fail:()=>{wx.hideLoading();wx.showToast({title:'提交失败',icon:'none'})},
      })
    } })
  },
})