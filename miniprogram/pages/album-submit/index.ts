import { getThemeClass } from '../../utils/theme'

interface ArtistPick { artistId:string; artistName:string; picUrl:string; albumSize:number; letter:string; selected?:boolean }
interface TrackRow { name:string; guests:ArtistPick[] }

let _artistSearchTimer:any=null
let _guestSearchTimer:any=null

const emptyTrackRow = (): TrackRow => ({ name:'', guests:[] })

Page({
  data:{
    statusBarHeight:20,topbarHeight:64,themeClass:'',
    mode:'search' as 'search'|'manual',searchName:'',searching:false,searchingPlatform:'' as ''|'netease'|'qq',submitting:false,
    title:'',releaseDate:'',company:'',description:'',coverUrl:'',localCover:'',
    artistKeyword:'',selectedArtists:[] as ArtistPick[],artistResults:[] as ArtistPick[],artistSearching:false,
    trackRows:[emptyTrackRow()] as TrackRow[],
    guestPickerVisible:false,guestPickerIndex:-1,guestPickerKeyword:'',guestPickerResults:[] as ArtistPick[],guestPickerSearching:false,
  },
  onLoad(){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight})},
  onShow(){this.setData({themeClass:getThemeClass()})},
  onBack(){wx.navigateBack()},
  onInput(e:WechatMiniprogram.Input){const field=String((e.currentTarget.dataset as any).field||'');if(field)this.setData({[field]:e.detail.value} as any)},

  onArtistSearchInput(e:WechatMiniprogram.Input){const artistKeyword=e.detail.value||'';this.setData({artistKeyword});if(_artistSearchTimer)clearTimeout(_artistSearchTimer);_artistSearchTimer=setTimeout(()=>this.searchArtists(artistKeyword),300)},
  searchArtists(keyword=''){const kw=String(keyword||'').trim();if(!kw){this.setData({artistResults:[],artistSearching:false});return}this.setData({artistSearching:true});wx.cloud.callFunction({name:'getArtists',data:{keyword:kw,limit:30},success:(res:any)=>{const r=res.result||{};const selectedIds=new Set(this.data.selectedArtists.map(a=>String(a.artistId)));const artistResults=(r.success?(r.list||[]):[]).map((a:ArtistPick)=>({...a,selected:selectedIds.has(String(a.artistId))}));this.setData({artistResults,artistSearching:false})},fail:(e:any)=>{console.error('[getArtists] fail', e);this.setData({artistSearching:false,artistResults:[]})}} as any)},
  onPickArtist(e:WechatMiniprogram.TouchEvent){const ds=e.currentTarget.dataset as any;const artistId=String(ds.id||'');if(!artistId)return;const selectedArtists=this.data.selectedArtists.slice();const index=selectedArtists.findIndex(a=>String(a.artistId)===artistId);if(index>=0)selectedArtists.splice(index,1);else{const found=this.data.artistResults.find(a=>String(a.artistId)===artistId);if(found)selectedArtists.push({...found,selected:true})}const selectedIds=new Set(selectedArtists.map(a=>String(a.artistId)));const artistResults=this.data.artistResults.map(a=>({...a,selected:selectedIds.has(String(a.artistId))}));this.setData({selectedArtists,artistResults})},
  onRemoveArtist(e:WechatMiniprogram.TouchEvent){const artistId=String((e.currentTarget.dataset as any).id||'');const selectedArtists=this.data.selectedArtists.filter(a=>String(a.artistId)!==artistId);const artistResults=this.data.artistResults.map(a=>({...a,selected:selectedArtists.some(x=>String(x.artistId)===String(a.artistId))}));this.setData({selectedArtists,artistResults})},

  onTrackNameInput(e:WechatMiniprogram.Input){const index=Number((e.currentTarget.dataset as any).index);const trackRows=this.data.trackRows.slice();if(!trackRows[index])return;trackRows[index]={...trackRows[index],name:e.detail.value};this.setData({trackRows})},
  onAddTrackRow(){this.setData({trackRows:[...this.data.trackRows,emptyTrackRow()]})},
  onRemoveTrackRow(e:WechatMiniprogram.TouchEvent){const index=Number((e.currentTarget.dataset as any).index);const trackRows=this.data.trackRows.filter((_,i)=>i!==index);this.setData({trackRows})},

  onOpenGuestPicker(e:WechatMiniprogram.TouchEvent){const index=Number((e.currentTarget.dataset as any).index);this.setData({guestPickerVisible:true,guestPickerIndex:index,guestPickerKeyword:'',guestPickerResults:[]})},
  onCloseGuestPicker(){this.setData({guestPickerVisible:false,guestPickerIndex:-1})},
  noop(){},
  onGuestSearchInput(e:WechatMiniprogram.Input){const guestPickerKeyword=e.detail.value||'';this.setData({guestPickerKeyword});if(_guestSearchTimer)clearTimeout(_guestSearchTimer);_guestSearchTimer=setTimeout(()=>this.searchGuests(guestPickerKeyword),300)},
  searchGuests(keyword=''){const kw=String(keyword||'').trim();if(!kw){this.setData({guestPickerResults:[],guestPickerSearching:false});return}this.setData({guestPickerSearching:true});wx.cloud.callFunction({name:'getArtists',data:{keyword:kw,limit:30},success:(res:any)=>{const r=res.result||{};const row=this.data.trackRows[this.data.guestPickerIndex];const selectedIds=new Set((row?row.guests:[]).map(a=>String(a.artistId)));const guestPickerResults=(r.success?(r.list||[]):[]).map((a:ArtistPick)=>({...a,selected:selectedIds.has(String(a.artistId))}));this.setData({guestPickerResults,guestPickerSearching:false})},fail:()=>this.setData({guestPickerSearching:false,guestPickerResults:[]})} as any)},
  onPickGuest(e:WechatMiniprogram.TouchEvent){const index=this.data.guestPickerIndex;if(index<0||!this.data.trackRows[index])return;const artistId=String((e.currentTarget.dataset as any).id||'');if(!artistId)return;const trackRows=this.data.trackRows.slice();const row=trackRows[index];const guests=row.guests.slice();const gIndex=guests.findIndex(g=>String(g.artistId)===artistId);if(gIndex>=0)guests.splice(gIndex,1);else{const found=this.data.guestPickerResults.find(a=>String(a.artistId)===artistId);if(found)guests.push({...found,selected:true})}trackRows[index]={...row,guests};const selectedIds=new Set(guests.map(g=>String(g.artistId)));const guestPickerResults=this.data.guestPickerResults.map(a=>({...a,selected:selectedIds.has(String(a.artistId))}));this.setData({trackRows,guestPickerResults})},
  onRemoveGuest(e:WechatMiniprogram.TouchEvent){const ds=e.currentTarget.dataset as any;const index=Number(ds.index);const guestId=String(ds.gid||'');const trackRows=this.data.trackRows.slice();const row=trackRows[index];if(!row)return;trackRows[index]={...row,guests:row.guests.filter(g=>String(g.artistId)!==guestId)};this.setData({trackRows})},

  searchPlatform(platform:'netease'|'qq'){
    const name=String(this.data.searchName||'').trim()
    if(!name){wx.showToast({title:'请输入专辑名称',icon:'none'});return}
    if(this.data.searching)return
    this.setData({searching:true,searchingPlatform:platform})
    wx.cloud.callFunction({name:'submitAlbumRequest',data:{action:platform==='qq'?'qq-search':'search',name},success:(res:any)=>{
      const r=res.result||{}
      this.setData({searching:false,searchingPlatform:''})
      if(!r.success){wx.showToast({title:r.error||'查询失败',icon:'none'});return}
      if(r.needsManual){wx.showToast({title:platform==='qq'?'QQ音乐未找到精确匹配':'网易云未找到，请尝试QQ音乐',icon:'none'});return}
      if(r.existed){wx.showToast({title:r.status==='approved'?'该专辑已收录':r.status==='pending'?'该专辑审核中':'已有记录',icon:'none'});return}
      wx.showToast({title:`已从${platform==='qq'?'QQ音乐':'网易云'}提交`,icon:'success'})
      setTimeout(()=>wx.navigateBack(),700)
    },fail:()=>{this.setData({searching:false,searchingPlatform:''});wx.showToast({title:'查询失败',icon:'none'})}} as any)
  },
  onSearch(){this.searchPlatform('netease')},
  onSearchNetEase(){this.searchPlatform('netease')},
  onSearchQQ(){this.searchPlatform('qq')},
  onManual(){this.setData({mode:'manual',title:String(this.data.searchName||'').trim()})},
  onChooseCover(){wx.chooseMedia({count:1,mediaType:['image'],sourceType:['album','camera'],success:(res:any)=>{const path=res.tempFiles&&res.tempFiles[0]&&res.tempFiles[0].tempFilePath;if(!path)return;this.setData({localCover:path});wx.showLoading({title:'上传封面…',mask:true});const ext=(path.split('.').pop()||'jpg').toLowerCase();const cloudPath=`album-submissions/${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;wx.cloud.uploadFile({cloudPath,filePath:path,success:(up:any)=>{wx.hideLoading();this.setData({coverUrl:up.fileID})},fail:()=>{wx.hideLoading();wx.showToast({title:'封面上传失败',icon:'none'})}})}})},

  onSubmitManual(){
    const title=String(this.data.title||'').trim()
    if(!title){wx.showToast({title:'请填写专辑名',icon:'none'});return}
    if(!this.data.selectedArtists.length){wx.showToast({title:'请至少选择一位已收录歌手',icon:'none'});return}
    if(!this.data.coverUrl){wx.showToast({title:'请上传专辑封面',icon:'none'});return}
    const tracks=this.data.trackRows.map(r=>({name:r.name.trim(),guests:r.guests.map(g=>({id:g.artistId,name:g.artistName}))})).filter(t=>t.name)
    if(!tracks.length){wx.showToast({title:'请至少填写一首曲目',icon:'none'});return}
    const artistIds=this.data.selectedArtists.map(a=>String(a.artistId))
    const selectedArtists=this.data.selectedArtists.map(a=>({id:a.artistId,name:a.artistName}))
    this.setData({submitting:true})
    wx.cloud.callFunction({name:'submitAlbumRequest',data:{action:'manual',title,releaseDate:String(this.data.releaseDate||'').trim(),company:String(this.data.company||'').trim(),description:String(this.data.description||'').trim(),tracks,coverUrl:this.data.coverUrl,artistIds,selectedArtists},success:(res:any)=>{const r=res.result||{};this.setData({submitting:false});if(!r.success){wx.showToast({title:r.error||'提交失败',icon:'none'});return}if(r.existed){wx.showToast({title:'该专辑已在审核中',icon:'none'});return}wx.showToast({title:'已提交管理员审核',icon:'success'});setTimeout(()=>wx.navigateBack(),700)},fail:()=>{this.setData({submitting:false});wx.showToast({title:'提交失败',icon:'none'})}} as any)
  },
})