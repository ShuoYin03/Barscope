import { getThemeClass } from '../../utils/theme'

type ArtistRole = 'rapper' | 'producer' | 'label'
interface ArtistRow { id:string; artistId:string; artistName:string; picUrl:string; albumSize:number; roles:ArtistRole[]; brands:string[] }

const ROLE_OPTIONS:{key:ArtistRole;label:string}[] = [
  { key:'rapper', label:'RAPPER' },
  { key:'producer', label:'PRODUCER' },
  { key:'label', label:'LABEL' },
]

Page({
  data:{
    statusBarHeight:20,
    themeClass:'',
    keyword:'',
    list:[] as ArtistRow[],
    loading:true,
    editorVisible:false,
    editingArtistId:'',
    editingArtistName:'',
    selectedRoles:[] as ArtistRole[],
    roleOptions:ROLE_OPTIONS.map(x=>({...x,selected:false})),
    submitting:false,
  },

  onLoad(){
    const app=getApp<IAppOption>()
    this.setData({statusBarHeight:app.globalData.statusBarHeight})
    this.loadArtists()
  },
  onShow(){this.setData({themeClass:getThemeClass()})},

  loadArtists(){
    this.setData({loading:true})
    wx.cloud.callFunction({
      name:'getArtists',
      data:{keyword:this.data.keyword.trim(),limit:1000},
      success:(res:any)=>{
        const r=res.result||{}
        const list=(r.success?(r.list||[]):[]).map((x:any)=>({
          ...x,
          roles:Array.isArray(x.roles)?x.roles:[],
          brands:Array.isArray(x.brands)?x.brands:[],
        }))
        this.setData({list,loading:false})
      },
      fail:()=>{this.setData({loading:false});wx.showToast({title:'加载失败',icon:'none'})},
    } as any)
  },

  onSearch(e:WechatMiniprogram.Input){
    this.setData({keyword:e.detail.value})
    this.loadArtists()
  },

  onEdit(e:WechatMiniprogram.TouchEvent){
    const id=String((e.currentTarget.dataset as any).id||'')
    const artist=this.data.list.find(x=>x.id===id)
    if(!artist)return
    const selectedRoles=[...(artist.roles||[])] as ArtistRole[]
    this.setData({
      editorVisible:true,
      editingArtistId:artist.artistId,
      editingArtistName:artist.artistName,
      selectedRoles,
      roleOptions:ROLE_OPTIONS.map(x=>({...x,selected:selectedRoles.includes(x.key)})),
    })
  },

  onToggleRole(e:WechatMiniprogram.TouchEvent){
    const role=String((e.currentTarget.dataset as any).role||'') as ArtistRole
    if(!ROLE_OPTIONS.some(x=>x.key===role))return
    const selectedRoles=this.data.selectedRoles.includes(role)
      ? this.data.selectedRoles.filter(x=>x!==role)
      : [...this.data.selectedRoles,role]
    this.setData({selectedRoles,roleOptions:ROLE_OPTIONS.map(x=>({...x,selected:selectedRoles.includes(x.key)}))})
  },

  onCloseEditor(){if(!this.data.submitting)this.setData({editorVisible:false})},

  onSubmit(){
    if(this.data.submitting||!this.data.editingArtistId)return
    const app=getApp<IAppOption>()
    if(!app.globalData.userInfo){
      wx.showModal({title:'需要登录',content:'登录后即可提交艺人身份修改建议。',confirmText:'去登录',success:r=>{if(r.confirm)wx.navigateTo({url:'/pages/login/index'})}})
      return
    }
    this.setData({submitting:true})
    wx.cloud.callFunction({
      name:'manageArtistBrands',
      data:{action:'submit_role_suggestion',artistId:this.data.editingArtistId,artistName:this.data.editingArtistName,roles:this.data.selectedRoles},
      success:(res:any)=>{
        const r=res.result||{}
        if(!r.success){wx.showToast({title:r.error||'提交失败',icon:'none'});return}
        this.setData({editorVisible:false})
        wx.showToast({title:'已提交审核',icon:'success'})
      },
      fail:()=>wx.showToast({title:'提交失败',icon:'none'}),
      complete:()=>this.setData({submitting:false}),
    } as any)
  },

  onBack(){wx.navigateBack()},
  noop(){},
})