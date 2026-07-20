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
    scanProgress:0,
    scanCurrent:0,
    scanTotal:0,
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
  _call(data:any):Promise<any>{
    return new Promise((resolve,reject)=>{
      wx.cloud.callFunction({name:'manageDataDiagnostics',data,success:(res:any)=>resolve(res.result||{}),fail:reject} as any)
    })
  },
  async onScan(){
    if(this.data.loading)return
    this.setData({loading:true,hasScanned:false,scanError:'',scanProgress:0,scanCurrent:0,scanTotal:0,missingArtists:[],missingOwnership:[],selectedCount:0})
    try{
      const meta=await this._call({action:'scan_meta'})
      if(!meta.success)throw new Error(meta.error==='unauthorized'?'仅管理员可用':(meta.detail||meta.error||'初始化扫描失败'))
      const total=Number(meta.albumCount||0)
      const pageSize=Number(meta.pageSize||80)
      const artistCount=Number(meta.artistCount||0)
      const artistMap=new Map<string,MissingArtist>()
      const ownership:MissingOwnership[]=[]
      let missingDescription=0
      let missingCover=0
      let missingReleaseDate=0
      let scannedAlbums=0
      let skip=0

      this.setData({scanTotal:total,summary:{...this.data.summary,albumCount:total,artistCount}})

      while(skip<total){
        const page=await this._call({action:'scan_page',skip,limit:pageSize})
        if(!page.success)throw new Error(page.detail||page.error||`扫描第 ${skip+1} 条数据时失败`)
        const fetched=Number(page.fetched||0)
        if(fetched<=0)break
        scannedAlbums+=Number(page.scanned||0)
        missingDescription+=Number(page.missingDescription||0)
        missingCover+=Number(page.missingCover||0)
        missingReleaseDate+=Number(page.missingReleaseDate||0)
        ownership.push(...(page.missingOwnership||[]))

        ;(page.missingArtists||[]).forEach((item:MissingArtist)=>{
          const key=item.artistId||`name:${String(item.artistName||'').trim().toLowerCase()}`
          const existing=artistMap.get(key)
          if(!existing){artistMap.set(key,{...item,selected:false,albumIds:[...(item.albumIds||[])],albums:[...(item.albums||[])]});return}
          existing.albumCount+=Number(item.albumCount||0)
          existing.albumIds=Array.from(new Set([...(existing.albumIds||[]),...(item.albumIds||[])]))
          const albumMap=new Map((existing.albums||[]).map(a=>[a.albumId,a]))
          ;(item.albums||[]).forEach(a=>albumMap.set(a.albumId,a))
          existing.albums=Array.from(albumMap.values()).slice(0,8)
        })

        skip=Number(page.nextSkip||skip+fetched)
        const current=Math.min(skip,total)
        const progress=total?Math.min(100,Math.round(current/total*100)):100
        const missingArtists=Array.from(artistMap.values()).sort((a,b)=>b.albumCount-a.albumCount||a.artistName.localeCompare(b.artistName))
        const issueCount=ownership.length+missingArtists.length+missingDescription+missingCover+missingReleaseDate
        const healthScore=scannedAlbums?Math.max(0,Math.round((1-issueCount/Math.max(scannedAlbums*4,1))*1000)/10):100
        this.setData({
          scanCurrent:current,
          scanProgress:progress,
          missingArtists,
          missingOwnership:ownership,
          summary:{healthScore,albumCount:scannedAlbums,artistCount,missingOwnership:ownership.length,missingArtists:missingArtists.length,missingDescription,missingCover,missingReleaseDate},
        })
      }

      const missingArtists=Array.from(artistMap.values()).sort((a,b)=>b.albumCount-a.albumCount||a.artistName.localeCompare(b.artistName))
      const issueCount=ownership.length+missingArtists.length+missingDescription+missingCover+missingReleaseDate
      const healthScore=scannedAlbums?Math.max(0,Math.round((1-issueCount/Math.max(scannedAlbums*4,1))*1000)/10):100
      this.setData({hasScanned:true,scanProgress:100,scanCurrent:total,scanTotal:total,missingArtists,missingOwnership:ownership,summary:{healthScore,albumCount:scannedAlbums,artistCount,missingOwnership:ownership.length,missingArtists:missingArtists.length,missingDescription,missingCover,missingReleaseDate}})
    }catch(err:any){
      const message=String(err&&err.message||err&&err.errMsg||'扫描失败')
      this.setData({hasScanned:false,scanError:message})
      wx.showToast({title:'扫描未完成',icon:'none'})
    }finally{
      this.setData({loading:false})
    }
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