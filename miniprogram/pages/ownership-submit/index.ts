import { getThemeClass } from '../../utils/theme'

interface ArtistPick {
  artistId:string
  artistName:string
  picUrl:string
  albumSize:number
  letter:string
  selected?:boolean
  original?:boolean
}

let _artistSearchTimer:any=null

Page({
  data:{
    statusBarHeight:20,
    themeClass:'',
    albumId:'',
    title:'',
    artistKeyword:'',
    selectedArtists:[] as ArtistPick[],
    artistResults:[] as ArtistPick[],
    artistSearching:false,
    ownershipLoading:true,
    reason:'',
  },

  onLoad(options){
    const app=getApp<IAppOption>()
    const albumId=String(options.albumId||'')
    const title=decodeURIComponent(String(options.title||''))
    this.setData({statusBarHeight:app.globalData.statusBarHeight,albumId,title})
    this.loadCurrentOwnership()
  },

  onShow(){this.setData({themeClass:getThemeClass()})},

  loadCurrentOwnership(){
    this.setData({ownershipLoading:true,artistSearching:true})

    const albumCall=wx.cloud.callFunction({
      name:'getAlbums',
      data:{id:this.data.albumId},
    }).catch(()=>({result:{success:false,album:null}}))

    const artistsCall=wx.cloud.callFunction({
      name:'getArtists',
      data:{keyword:'',limit:1000},
    }).catch(()=>({result:{success:false,list:[]}}))

    Promise.all([albumCall,artistsCall]).then((responses:any[])=>{
      const albumResult=responses[0]?.result||{}
      const artistsResult=responses[1]?.result||{}
      const album=albumResult.success?albumResult.album:null
      const allArtists:ArtistPick[]=artistsResult.success?(artistsResult.list||[]):[]

      const ownerIds=new Set<string>()
      if(album){
        if(Array.isArray(album.artistIds)) album.artistIds.forEach((id:any)=>{if(id)ownerIds.add(String(id))})
        if(album.neteaseArtistId) ownerIds.add(String(album.neteaseArtistId))
      }

      let selectedArtists=allArtists
        .filter(a=>ownerIds.has(String(a.artistId)))
        .map(a=>({...a,selected:true,original:true}))

      if(!selectedArtists.length&&album){
        const fallbackNames=String(album.artist||album.primaryArtist||'')
          .split(/[\/、,，&]/)
          .map((x:string)=>x.trim())
          .filter(Boolean)
        selectedArtists=allArtists
          .filter(a=>fallbackNames.includes(String(a.artistName||'').trim()))
          .map(a=>({...a,selected:true,original:true}))
      }

      const selectedIds=new Set(selectedArtists.map(a=>String(a.artistId)))
      const artistResults=allArtists.slice(0,30).map(a=>({...a,selected:selectedIds.has(String(a.artistId))}))

      this.setData({
        selectedArtists,
        artistResults,
        ownershipLoading:false,
        artistSearching:false,
      })
    })
  },

  onTargetInput(e:WechatMiniprogram.Input){
    const artistKeyword=e.detail.value||''
    this.setData({artistKeyword})
    if(_artistSearchTimer)clearTimeout(_artistSearchTimer)
    _artistSearchTimer=setTimeout(()=>this.searchArtists(artistKeyword),300)
  },

  searchArtists(keyword=''){
    this.setData({artistSearching:true})
    wx.cloud.callFunction({
      name:'getArtists',
      data:{keyword:String(keyword||'').trim(),limit:30},
      success:(res:any)=>{
        const r=res.result||{}
        const selectedIds=new Set(this.data.selectedArtists.map(a=>String(a.artistId)))
        const artistResults=(r.success?(r.list||[]):[]).map((a:ArtistPick)=>({...a,selected:selectedIds.has(String(a.artistId))}))
        this.setData({artistResults,artistSearching:false})
      },
      fail:(e:any)=>{
        console.error('[getArtists] fail',e)
        this.setData({artistSearching:false,artistResults:[]})
      },
    } as any)
  },

  onPickArtist(e:WechatMiniprogram.TouchEvent){
    const ds=e.currentTarget.dataset as any
    const artistId=String(ds.id||'')
    if(!artistId)return

    const selectedArtists=this.data.selectedArtists.slice()
    const index=selectedArtists.findIndex(a=>String(a.artistId)===artistId)

    if(index>=0){
      selectedArtists.splice(index,1)
    }else{
      const found=this.data.artistResults.find(a=>String(a.artistId)===artistId)
      if(found)selectedArtists.push({...found,selected:true,original:false})
    }

    const selectedIds=new Set(selectedArtists.map(a=>String(a.artistId)))
    const artistResults=this.data.artistResults.map(a=>({...a,selected:selectedIds.has(String(a.artistId))}))
    this.setData({selectedArtists,artistResults})
  },

  onRemoveArtist(e:WechatMiniprogram.TouchEvent){
    const artistId=String((e.currentTarget.dataset as any).id||'')
    const selectedArtists=this.data.selectedArtists.filter(a=>String(a.artistId)!==artistId)
    const artistResults=this.data.artistResults.map(a=>({...a,selected:selectedArtists.some(x=>String(x.artistId)===String(a.artistId))}))
    this.setData({selectedArtists,artistResults})
  },

  onReasonInput(e:WechatMiniprogram.Input){this.setData({reason:e.detail.value||''})},

  onSubmit(){
    const targetArtists=this.data.selectedArtists.map(a=>({artistId:String(a.artistId),artistName:String(a.artistName)}))
    if(!targetArtists.length){
      wx.showToast({title:'至少保留一位 rapper',icon:'none'})
      return
    }

    wx.showLoading({title:'提交中…',mask:true})
    wx.cloud.callFunction({
      name:'submitAlbumOwnershipCorrection',
      data:{albumId:this.data.albumId,targetArtists,reason:this.data.reason},
      success:(res:any)=>{
        wx.hideLoading()
        const r=res.result||{}
        if(!r.success){
          wx.showToast({title:r.error||'提交失败',icon:'none'})
          console.error('[submitAlbumOwnershipCorrection] result error',r)
          return
        }
        const names=(r.targetArtistNames||targetArtists.map(x=>x.artistName)).join(' / ')
        wx.showModal({
          title:r.existed?'已在审核中':'已提交',
          content:`归属修改已提交给管理员复核：${names}`,
          showCancel:false,
          success:()=>wx.navigateBack(),
        })
      },
      fail:(e:any)=>{
        wx.hideLoading()
        console.error('[submitAlbumOwnershipCorrection] call fail',e)
        wx.showToast({title:(e&&e.errMsg)||'提交失败',icon:'none',duration:3000})
      },
    } as any)
  },

  onBack(){wx.navigateBack()},

  onUnload(){if(_artistSearchTimer)clearTimeout(_artistSearchTimer)},
})