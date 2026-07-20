import { getThemeClass } from '../../utils/theme'

interface TrackGuest { id:number; name:string }
interface EditTrack { songId:string; name:string; guests:TrackGuest[]; clientKey:string }
interface GuestPick { artistId:string; artistName:string; picUrl:string; selected?:boolean }

let _pickerSearchTimer:any = null

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
    editVisible:false,
    editTrackIndex:-1,
    editName:'',
    editIsNew:false,
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

  onShow(){ this.setData({themeClass:getThemeClass()}) },

  _loadTracks(albumId:string){
    this.setData({loading:true})
    wx.cloud.callFunction({
      name:'getAlbums',
      data:{id:albumId},
      success:(res:any)=>{
        const r=res.result||{}
        const album=r.success?r.album:null
        const tracks:EditTrack[]=((album&&album.tracks)||[]).map((t:any,index:number)=>({
          songId:String(t.songId||''),
          name:t.name||'',
          guests:(t.guests||[]).map((g:any)=>({id:Number(g.id||0),name:g.name||''})),
          clientKey:`existing-${String(t.songId||index)}-${index}`,
        }))
        this.setData({tracks,loading:false})
      },
      fail:()=>{
        this.setData({loading:false})
        wx.showToast({title:'加载失败',icon:'none'})
      },
    } as any)
  },

  onOpenTrack(e:WechatMiniprogram.TouchEvent){
    const idx=Number((e.currentTarget.dataset as any).idx)
    const track=this.data.tracks[idx]
    if(!track)return
    this.setData({editVisible:true,editTrackIndex:idx,editName:track.name,editIsNew:false})
  },

  onAddTrack(){
    const tracks=this.data.tracks.slice()
    const idx=tracks.length
    tracks.push({
      songId:'',
      name:'',
      guests:[],
      clientKey:`new-${Date.now()}-${idx}`,
    })
    this.setData({
      tracks,
      editVisible:true,
      editTrackIndex:idx,
      editName:'',
      editIsNew:true,
    })
  },

  onEditNameInput(e:WechatMiniprogram.Input){
    this.setData({editName:e.detail.value||''})
  },

  onEditCancel(){
    if(this.data.editIsNew&&this.data.editTrackIndex>=0){
      const tracks=this.data.tracks.slice()
      tracks.splice(this.data.editTrackIndex,1)
      this.setData({tracks})
    }
    this.setData({editVisible:false,editTrackIndex:-1,editName:'',editIsNew:false})
  },

  onEditConfirm(){
    const idx=this.data.editTrackIndex
    const name=String(this.data.editName||'').trim()
    if(idx<0)return
    if(!name){wx.showToast({title:'曲目名称不能为空',icon:'none'});return}
    const tracks=this.data.tracks.slice()
    tracks[idx]={...tracks[idx],name}
    this.setData({tracks,editVisible:false,editTrackIndex:-1,editName:'',editIsNew:false})
  },

  onMoveUp(e:WechatMiniprogram.TouchEvent){
    const idx=Number((e.currentTarget.dataset as any).idx)
    if(idx<=0)return
    const tracks=this.data.tracks.slice()
    ;[tracks[idx-1],tracks[idx]]=[tracks[idx],tracks[idx-1]]
    this.setData({tracks})
  },

  onMoveDown(e:WechatMiniprogram.TouchEvent){
    const idx=Number((e.currentTarget.dataset as any).idx)
    if(idx>=this.data.tracks.length-1)return
    const tracks=this.data.tracks.slice()
    ;[tracks[idx+1],tracks[idx]]=[tracks[idx],tracks[idx+1]]
    this.setData({tracks})
  },

  onEditGuests(){
    const idx=this.data.editTrackIndex
    const track=this.data.tracks[idx]
    if(idx<0||!track)return
    this.setData({
      pickerVisible:true,
      pickerTrackIndex:idx,
      pickerKeyword:'',
      pickerSelected:(track.guests||[]).map(g=>({artistId:String(g.id||''),artistName:g.name,picUrl:'',selected:true})),
    })
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
          artistId:String(a.artistId),
          artistName:a.artistName||'',
          picUrl:a.picUrl||'',
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
    if(idx>=0)selected.splice(idx,1)
    else{
      const found=this.data.pickerResults.find(a=>a.artistId===artistId)
      if(found)selected.push({...found,selected:true})
    }
    const ids=new Set(selected.map(a=>a.artistId))
    this.setData({
      pickerSelected:selected,
      pickerResults:this.data.pickerResults.map(a=>({...a,selected:ids.has(a.artistId)})),
    })
  },

  onPickerRemove(e:WechatMiniprogram.TouchEvent){
    const id=String((e.currentTarget.dataset as any).id||'')
    const selected=this.data.pickerSelected.filter(a=>a.artistId!==id)
    this.setData({
      pickerSelected:selected,
      pickerResults:this.data.pickerResults.map(a=>({...a,selected:selected.some(x=>x.artistId===a.artistId)})),
    })
  },

  onPickerCancel(){ this.setData({pickerVisible:false,pickerTrackIndex:-1}) },

  onPickerConfirm(){
    const idx=this.data.pickerTrackIndex
    if(idx<0)return
    const tracks=this.data.tracks.slice()
    tracks[idx]={
      ...tracks[idx],
      guests:this.data.pickerSelected.map(a=>({id:Number(a.artistId)||0,name:a.artistName})),
    }
    this.setData({tracks,pickerVisible:false,pickerTrackIndex:-1})
  },

  onSave(){
    if(this.data.saving)return
    const tracks=this.data.tracks.map(t=>({songId:t.songId,name:t.name.trim(),guests:t.guests}))
    if(tracks.some(t=>!t.name)){wx.showToast({title:'曲目名称不能为空',icon:'none'});return}
    wx.showModal({
      title:'提交曲目修改？',
      content:'修改不会立即生效，需由管理员审核通过后更新专辑。',
      confirmText:'提交审核',
      confirmColor:'#D45124',
      success:modal=>{
        if(!modal.confirm)return
        this.setData({saving:true})
        wx.showLoading({title:'提交中…',mask:true})
        wx.cloud.callFunction({
          name:'manageTrackCorrections',
          data:{action:'submit',albumId:this.data.albumId,albumTitle:this.data.albumTitle,tracks},
          success:(res:any)=>{
            wx.hideLoading()
            this.setData({saving:false})
            const r=res.result||{}
            if(!r.success){wx.showToast({title:r.error||'提交失败',icon:'none'});return}
            wx.showToast({title:'已提交审核',icon:'success'})
            setTimeout(()=>wx.navigateBack(),700)
          },
          fail:()=>{
            wx.hideLoading()
            this.setData({saving:false})
            wx.showToast({title:'网络错误',icon:'none'})
          },
        } as any)
      },
    })
  },

  onBack(){wx.navigateBack()},
  noop(){},
})