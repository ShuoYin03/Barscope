import { getThemeClass } from '../../utils/theme'

type ArtistRole = 'rapper' | 'producer' | 'label'
const ROLE_OPTIONS:{key:ArtistRole;label:string}[] = [
  { key:'rapper', label:'RAPPER' },
  { key:'producer', label:'PRODUCER' },
  { key:'label', label:'LABEL' },
]

Page({
  data:{
    statusBarHeight:20,
    topbarHeight:64,
    themeClass:'',
    artistId:'',
    artistName:'',
    avatarUrl:'',
    heroImageUrl:'',
    briefDesc:'',
    roles:[] as ArtistRole[],
    roleOptions:ROLE_OPTIONS.map(x=>({...x,selected:false})),
    loading:true,
    saving:false,
    uploadingAvatar:false,
    uploadingHero:false,
  },
  onLoad(options){
    const app=getApp<IAppOption>()
    const artistId=String(options.artistId||'')
    const artistName=decodeURIComponent(String(options.artistName||''))
    this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight,artistId,artistName})
    if(artistId){this._loadArtist(artistId);return}
    if(!artistName){wx.showToast({title:'缺少艺人信息',icon:'none'});this.setData({loading:false});return}
    wx.cloud.callFunction({name:'getArtists',data:{keyword:artistName,limit:30},success:(res:any)=>{
      const list=res.result&&res.result.success?(res.result.list||[]):[]
      const exact=list.find((a:any)=>String(a.artistName||a.name||'').trim()===artistName.trim())||list[0]
      const resolvedId=String(exact&&exact.artistId||'')
      if(!resolvedId){wx.showToast({title:'未找到该艺人',icon:'none'});this.setData({loading:false});return}
      this.setData({artistId:resolvedId})
      this._loadArtist(resolvedId)
    },fail:()=>{this.setData({loading:false});wx.showToast({title:'加载失败',icon:'none'})}} as any)
  },
  _loadArtist(artistId:string){
    wx.cloud.callFunction({name:'getArtist',data:{artistId},success:(res:any)=>{
      const a=res.result&&res.result.artist
      if(!a){wx.showToast({title:'艺人不存在',icon:'none'});this.setData({loading:false});return}
      const roles=(Array.isArray(a.roles)?a.roles:[]).filter((x:string)=>ROLE_OPTIONS.some(r=>r.key===x)) as ArtistRole[]
      this.setData({artistName:a.artistName||a.name||this.data.artistName||'',avatarUrl:a.avatarUrl||a.picUrl||'',heroImageUrl:a.heroImageUrl||a.backgroundUrl||a.coverUrl||'',briefDesc:a.briefDesc||a.description||'',roles,roleOptions:ROLE_OPTIONS.map(x=>({...x,selected:roles.includes(x.key)})),loading:false})
    },fail:()=>{this.setData({loading:false});wx.showToast({title:'加载失败',icon:'none'})}} as any)
  },
  onShow(){this.setData({themeClass:getThemeClass()})},
  onBack(){wx.navigateBack()},
  onInput(e:WechatMiniprogram.Input){const field=String((e.currentTarget.dataset as any).field||'');if(field)this.setData({[field]:e.detail.value} as any)},
  onToggleRole(e:WechatMiniprogram.TouchEvent){
    const role=String((e.currentTarget.dataset as any).role||'') as ArtistRole
    if(!ROLE_OPTIONS.some(x=>x.key===role))return
    const roles=this.data.roles.includes(role)?this.data.roles.filter(x=>x!==role):[...this.data.roles,role]
    this.setData({roles,roleOptions:ROLE_OPTIONS.map(x=>({...x,selected:roles.includes(x.key)}))})
  },
  _chooseImage(kind:'avatar'|'hero'){
    if(this.data.uploadingAvatar||this.data.uploadingHero)return
    wx.chooseMedia({count:1,mediaType:['image'],sourceType:['album','camera'],success:(res:any)=>{
      const filePath=res.tempFiles&&res.tempFiles[0]&&res.tempFiles[0].tempFilePath
      if(!filePath)return
      const loadingKey=kind==='avatar'?'uploadingAvatar':'uploadingHero'
      this.setData({[loadingKey]:true} as any)
      wx.showLoading({title:kind==='avatar'?'上传头像…':'上传壁纸…',mask:true})
      const ext=(filePath.split('.').pop()||'jpg').toLowerCase()
      wx.cloud.uploadFile({cloudPath:`artist-images/manual/${this.data.artistId}_${kind}_${Date.now()}.${ext}`,filePath,success:(up:any)=>{wx.hideLoading();this.setData({[kind==='avatar'?'avatarUrl':'heroImageUrl']:up.fileID,[loadingKey]:false} as any)},fail:()=>{wx.hideLoading();this.setData({[loadingKey]:false} as any);wx.showToast({title:'图片上传失败',icon:'none'})}})
    }})
  },
  onChooseAvatar(){this._chooseImage('avatar')},
  onChooseHero(){this._chooseImage('hero')},
  onSave(){
    if(this.data.saving)return
    const artistName=String(this.data.artistName||'').trim()
    if(!artistName){wx.showToast({title:'艺人名称不能为空',icon:'none'});return}
    this.setData({saving:true});wx.showLoading({title:'提交中…',mask:true})
    wx.cloud.callFunction({name:'manageArtistCorrections',data:{action:'submit',artistId:this.data.artistId,artistName,roles:this.data.roles,avatarUrl:this.data.avatarUrl,heroImageUrl:this.data.heroImageUrl,briefDesc:String(this.data.briefDesc||'').trim()},success:(res:any)=>{wx.hideLoading();this.setData({saving:false});const r=res.result||{};if(!r.success){wx.showToast({title:r.error||'提交失败',icon:'none'});return}wx.showToast({title:'已提交管理员审核',icon:'success'});setTimeout(()=>wx.navigateBack(),700)},fail:(err:any)=>{wx.hideLoading();this.setData({saving:false});wx.showToast({title:String(err&&err.errMsg||'提交失败').slice(0,28),icon:'none'})}} as any)
  },
})