import { getThemeClass } from '../../utils/theme'

interface TrackGuest { id:number; name:string }
interface EditTrack { songId:string; name:string; guests:TrackGuest[] }
interface GuestPick { artistId:string; artistName:string; picUrl:string; selected?:boolean }

let _pickerSearchTimer:any=null

Page({
  data:{
    statusBarHeight:20,
    topbarHeight:64,
    themeClass:'',
    albumId:'',
    albumTitle:'',
    tracks:[] as EditTrack[],
    loading:true,
    saving:false,
    pickerVisible:false,
    pickerTrackIndex:-1,
    pickerKeyword:'',
    pickerResults:[] as GuestPick[],
    pickerSelected:[] as GuestPick[],
  },

  onLoad(options){
    const app=getApp<IAppOption>()
    const albumId=String(options.albumId||'')
    const albumTitle=decodeURIComponent(String(options.title||''))
    this.setData({
      statusBarHeight:app.globalData.statusBarHeight,
      topbarHeight:app.globalData.topbarHeight,
      albumId,
      albumTitle,
    })
    this._loadTracks(albumId)
  },

  onShow(){this.setData({themeClass:getThemeClass()})},

  _loadTracks(albumId:string){
    this.setData({loading:true})
    wx.cloud.callFunction({
      name:'getAlbums',
      data:{id:albumId},
      success:(res:any)=>{
        const r=res.result||{}
        const album=r.success?r.album:null
        const tracks:EditTrack[]=((album&&album.tracks)||[]).map((t:any)=>({
          songId:String(t.songId||''),
          name:t.name||'',
          guests:(t.guests||[]).map((g:any)=>({id:Number(g.id||0),name:g.name||''})),
        }))
        this.setData({tracks,loading:false})
      },
      fail:()=>{this.setData({loading:false});wx.showToast({title:'加载失败',icon:'none'})},
    } as any)
  },

  onNameInput(e:WechatMiniprogram.Input){
    const idx=Number((e.currentTarget.dataset as any).idx)
    const tracks=this.data.tracks.slice()
    tracks[idx]={...tracks[idx],name:e.detail.value||''}
    this.setData({tracks})
  },

  onMoveUp(e:WechatMiniprogram.TouchEvent){
    const idx=Number((e.currentTarget.dataset as any).idx)
    if(idx<=0)return
    const tracks=this.data.tracks.slice()
    const tmp=tracks[idx-1];tracks[idx-1]=tracks[idx];tracks[idx]=tmp
    this.setData({tracks})
  },

  onMoveDown(e:WechatMiniprogram.TouchEvent){
    const idx=Number((e.currentTarget.dataset as any).idx)
    const tracks=this.data.tracks.slice()
    if(idx>=tracks.length-1)return
    const tmp=tracks[idx+1];tracks[idx+1]=tracks[idx];tracks[idx]=tmp
    this.setData({tracks})
  },

  onEditGuests(e:WechatMiniprogram.TouchEvent){
    const idx=Number((e.currentTarget.dataset as any).idx)
    const track=this.data.tracks[idx]
    const pickerSelected:GuestPick[]=(track.guests||[]).map(g=>({artistId:String(g.id||''),artistName:g.name,picUrl:'',selected:true}))
    this.setData({pickerVisible:true,pickerTrackIndex:idx,pickerKeyword:'',pickerSelected})
    this._searchGuestPicker('')
  },

  _searchGuestPicker(keyword:string){
    wx.cloud.callFunction({
      name:'getArtists',
      data:{keyword:String(keyword||'').trim(),limit:30},
      success:(res:any)=>{
        const r=res.result||{}
        const selectedIds=new Set(this.data.pickerSelected.map(a=>a.artistId))
        const pickerResults:GuestPick[]=(r.success?(r.list||[]):[]).map((a:any)=>({
          artistId:String(a.artistId),artistName:a.artistName||'',picUrl:a.picUrl||'',
          selected:selectedIds.has(String(a.artistId)),
        }))
        this.setData({pickerResults})
      },
    } as any)
  },

  onPickerSearch(e:WechatMiniprogram.Input){
    const keyword=e.detail.value||''
    this.setData({pickerKeyword:keyword})
    clearTimeout(_pickerSearchTimer)
    _pickerSearchTimer=setTimeout(()=>this._searchGuestPicker(keyword),300)
  },

  onPickerPick(e:WechatMiniprogram.TouchEvent){
    const artistId=String((e.currentTarget.dataset as any).id||'')
    if(!artistId)return
    const selected=this.data.pickerSelected.slice()
    const idx=selected.findIndex(a=>a.artistId===artistId)
    if(idx>=0){
      selected.splice(idx,1)
    }else{
      const found=this.data.pickerResults.find(a=>a.artistId===artistId)
      if(found)selected.push({...found,selected:true})
    }
    const selectedIds=new Set(selected.map(a=>a.artistId))
    const pickerResults=this.data.pickerResults.map(a=>({...a,selected:selectedIds.has(a.artistId)}))
    this.setData({pickerSelected:selected,pickerResults})
  },

  onPickerRemove(e:WechatMiniprogram.TouchEvent){
    const artistId=String((e.currentTarget.dataset as any).id||'')
    const pickerSelected=this.data.pickerSelected.filter(a=>a.artistId!==artistId)
    const pickerResults=this.data.pickerResults.map(a=>({...a,selected:pickerSelected.some(x=>x.artistId===a.artistId)}))
    this.setData({pickerSelected,pickerResults})
  },

  onPickerCancel(){this.setData({pickerVisible:false,pickerTrackIndex:-1})},

  onPickerConfirm(){
    const idx=this.data.pickerTrackIndex
    if(idx<0)return
    const guests:TrackGuest[]=this.data.pickerSelected.map(a=>({id:Number(a.artistId)||0,name:a.artistName}))
    const tracks=this.data.tracks.slice()
    tracks[idx]={...tracks[idx],guests}
    this.setData({tracks,pickerVisible:false,pickerTrackIndex:-1})
  },

  onSave(){
    if(this.data.saving)return
    const tracks=this.data.tracks.map(t=>({songId:t.songId,name:t.name.trim(),guests:t.guests}))
    if(tracks.some(t=>!t.name)){wx.showToast({title:'曲目名称不能为空',icon:'none'});return}
    this.setData({saving:true})
    wx.showLoading({title:'保存中…',mask:true})
    wx.cloud.callFunction({
      name:'updateAlbumTracks',
      data:{albumId:this.data.albumId,tracks},
      success:(res:any)=>{
        wx.hideLoading()
        this.setData({saving:false})
        const r=res.result||{}
        if(!r.success){wx.showToast({title:r.error||'保存失败',icon:'none'});return}
        wx.showToast({title:'已保存',icon:'success'})
        setTimeout(()=>wx.navigateBack(),600)
      },
      fail:()=>{wx.hideLoading();this.setData({saving:false});wx.showToast({title:'网络错误',icon:'none'})},
    } as any)
  },

  onBack(){wx.navigateBack()},
  noop(){},
})