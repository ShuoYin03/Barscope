import { getThemeClass } from '../../utils/theme'

type MissingArtist = { artistId:string; artistName:string; albumCount:number; albumIds:string[]; albums:{albumId:string;title:string;coverUrl:string}[]; selected?:boolean }
type MissingOwnership = { albumId:string; title:string; artist:string; coverUrl:string; sourceId:string }

Page({
  data:{
    statusBarHeight:20,
    topbarHeight:64,
    themeClass:'',
    loading:false,
    sending:false,
    hasScanned:false,
    scanError:'',
    activeTab:'artists' as 'artists'|'ownership',
    summary:{healthScore:100,albumCount:0,artistCount:0,missingOwnership:0,missingArtists:0,missingDescription:0,missingCover:0,missingReleaseDate:0},
    missingArtists:[] as MissingArtist[],
    missingOwnership:[] as MissingOwnership[],
    selectedCount:0,
  },
  onLoad(){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight});this.onScan()},
  onShow(){this.setData({themeClass:getThemeClass()})},
  onBack(){wx.navigateBack()},
  onTabTap(e:WechatMiniprogram.TouchEvent){const tab=String((e.currentTarget.dataset as any).tab||'artists') as 'artists'|'ownership';this.setData({activeTab:tab})},
  onScan(){
    if(this.data.loading)return
    this.setData({loading:true,scanError:''})
    wx.cloud.callFunction({
      name:'manageDataDiagnostics',
      data:{action:'scan'},
      success:(res:any)=>{
        const r=res.result||{}
        if(!r.success){
          const message=r.error==='unauthorized'?'仅管理员可用':(r.detail||r.error||'扫描失败')
          this.setData({hasScanned:false,scanError:message})
          wx.showToast({title:r.error==='unauthorized'?'仅管理员可用':'扫描失败',icon:'none'})
          return
        }
        this.setData({hasScanned:true,scanError:'',summary:r.summary||this.data.summary,missingArtists:(r.missingArtists||[]).map((x:any)=>({...x,selected:false})),missingOwnership:r.missingOwnership||[],selectedCount:0})
      },
      fail:(err:any)=>{
        const message=String(err&&err.errMsg||'云函数调用失败')
        this.setData({hasScanned:false,scanError:message})
        wx.showToast({title:'扫描失败',icon:'none'})
      },
      complete:()=>this.setData({loading:false}),
    } as any)
  },
  onToggleArtist(e:WechatMiniprogram.TouchEvent){
    const id=String((e.currentTarget.dataset as any).id||'')
    const name=String((e.currentTarget.dataset as any).name||'')
    const list=this.data.missingArtists.map(x=>(x.artistId===id&&x.artistName===name)?{...x,selected:!x.selected}:x)
    this.setData({missingArtists:list,selectedCount:list.filter(x=>x.selected).length})
  },
  onSelectAll(){
    const allSelected=this.data.missingArtists.length>0&&this.data.missingArtists.every(x=>x.selected)
    const list=this.data.missingArtists.map(x=>({...x,selected:!allSelected}))
    this.setData({missingArtists:list,selectedCount:list.filter(x=>x.selected).length})
  },
  onSendAll(){
    if(!this.data.missingArtists.length){wx.showToast({title:'没有可送审的艺人',icon:'none'});return}
    this._send(this.data.missingArtists)
  },
  onSendSelected(){
    const items=this.data.missingArtists.filter(x=>x.selected)
    if(!items.length){wx.showToast({title:'请先选择艺人',icon:'none'});return}
    this._send(items)
  },
  onSendOne(e:WechatMiniprogram.TouchEvent){
    const id=String((e.currentTarget.dataset as any).id||'')
    const name=String((e.currentTarget.dataset as any).name||'')
    const item=this.data.missingArtists.find(x=>x.artistId===id&&x.artistName===name)
    if(item)this._send([item])
  },
  _send(items:MissingArtist[]){
    if(this.data.sending)return
    this.setData({sending:true})
    wx.showLoading({title:'送入审核中…',mask:true})
    wx.cloud.callFunction({
      name:'manageDataDiagnostics',
      data:{action:'send_artists_to_review',items},
      success:(res:any)=>{
        const r=res.result||{}
        if(!r.success){wx.showToast({title:r.error||'操作失败',icon:'none'});return}
        wx.showToast({title:`新增 ${r.inserted||0} 位候选`,icon:'success'})
        this.onScan()
      },
      fail:()=>wx.showToast({title:'操作失败',icon:'none'}),
      complete:()=>{wx.hideLoading();this.setData({sending:false})},
    } as any)
  },
  onAlbumTap(e:WechatMiniprogram.TouchEvent){const id=String((e.currentTarget.dataset as any).id||'');if(id)wx.navigateTo({url:`/pages/album-detail/index?id=${id}`})},
})