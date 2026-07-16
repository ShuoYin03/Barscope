import { getThemeClass } from '../../utils/theme'

type ArtistRole = 'rapper' | 'producer' | 'label'
interface ArtistRow { id:string; artistId:string; artistName:string; picUrl:string; albumSize:number; brands:string[]; roles:ArtistRole[]; selected?:boolean }
interface BrandOption { name:string; selected:boolean }
interface RoleOption { key:ArtistRole; label:string; selected:boolean }

const ROLE_OPTIONS:{key:ArtistRole;label:string}[] = [
  { key:'rapper', label:'RAPPER' },
  { key:'producer', label:'PRODUCER' },
  { key:'label', label:'LABEL' },
]

Page({
  data:{
    statusBarHeight:20, themeClass:'', keyword:'', list:[] as ArtistRow[], loading:true,
    brandSheetVisible:false, editingArtistId:'', editingArtistName:'', brandNames:[] as string[], brandOptions:[] as BrandOption[], selectedBrands:[] as string[],
    roleOptions:ROLE_OPTIONS.map(x=>({...x,selected:false})) as RoleOption[], selectedRoles:[] as ArtistRole[], saving:false,
    batchMode:false, batchSelectedCount:0, batchRoleSheetVisible:false, batchRoles:[] as ArtistRole[], batchRoleOptions:ROLE_OPTIONS.map(x=>({...x,selected:false})) as RoleOption[], batchSaving:false,
  },

  onLoad(){ const app=getApp<IAppOption>(); this.setData({statusBarHeight:app.globalData.statusBarHeight}); this.loadArtists() },
  onShow(){ this.setData({themeClass:getThemeClass()}) },

  loadArtists(){
    this.setData({loading:true})
    const keyword=this.data.keyword.trim()
    const listCall=wx.cloud.callFunction({name:'getArtists',data:{keyword,limit:1000}}).catch(()=>({result:{success:false,list:[]}}))
    const brandCall=keyword?wx.cloud.callFunction({name:'getArtists',data:{keyword:'',limit:1000}}).catch(()=>({result:{success:false,list:[]}})):listCall
    Promise.all([listCall,brandCall]).then((results:any[])=>{
      const listResult=results[0]?.result||{}, brandResult=results[1]?.result||{}
      const list:ArtistRow[]=(listResult.success?(listResult.list||[]):[]).map((x:any)=>({...x,roles:Array.isArray(x.roles)?x.roles:[],selected:false}))
      const allArtists:ArtistRow[]=brandResult.success?(brandResult.list||[]):[]
      const brandNames=Array.from(new Set(allArtists.flatMap(x=>x.brands||[]).map(x=>String(x||'').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'zh-CN'))
      this.setData({list,brandNames,loading:false,batchSelectedCount:0})
    }).catch(()=>{ this.setData({loading:false}); wx.showToast({title:'加载失败',icon:'none'}) })
  },

  onSearch(e:WechatMiniprogram.Input){ this.setData({keyword:e.detail.value}); this.loadArtists() },
  onToggleBatchMode(){
    const batchMode=!this.data.batchMode
    this.setData({batchMode,batchSelectedCount:0,list:this.data.list.map(x=>({...x,selected:false}))})
  },
  onRowTap(e:WechatMiniprogram.TouchEvent){
    const id=String((e.currentTarget.dataset as any).id||'')
    if(this.data.batchMode){
      const list=this.data.list.map(x=>x.id===id?{...x,selected:!x.selected}:x)
      this.setData({list,batchSelectedCount:list.filter(x=>x.selected).length})
      return
    }
    this.openEditor(id)
  },
  openEditor(id:string){
    const artist=this.data.list.find(x=>x.id===id); if(!artist)return
    const selectedBrands=[...(artist.brands||[])], selectedRoles=[...(artist.roles||[])] as ArtistRole[]
    const brandNames=Array.from(new Set([...this.data.brandNames,...selectedBrands])).sort((a,b)=>a.localeCompare(b,'zh-CN'))
    this.setData({brandSheetVisible:true,editingArtistId:id,editingArtistName:artist.artistName,selectedBrands,selectedRoles,brandNames,brandOptions:brandNames.map(name=>({name,selected:selectedBrands.includes(name)})),roleOptions:ROLE_OPTIONS.map(role=>({...role,selected:selectedRoles.includes(role.key)}))})
  },
  onToggleRole(e:WechatMiniprogram.TouchEvent){
    const role=String((e.currentTarget.dataset as any).role||'') as ArtistRole; if(!ROLE_OPTIONS.some(x=>x.key===role))return
    const selectedRoles=this.data.selectedRoles.includes(role)?this.data.selectedRoles.filter(x=>x!==role):[...this.data.selectedRoles,role]
    this.setData({selectedRoles,roleOptions:ROLE_OPTIONS.map(item=>({...item,selected:selectedRoles.includes(item.key)}))})
  },
  onToggleBrand(e:WechatMiniprogram.TouchEvent){
    const brand=String((e.currentTarget.dataset as any).brand||''); if(!brand)return
    const selectedBrands=this.data.selectedBrands.includes(brand)?this.data.selectedBrands.filter(x=>x!==brand):[...this.data.selectedBrands,brand].slice(0,10)
    this.setData({selectedBrands,brandOptions:this.data.brandNames.map(name=>({name,selected:selectedBrands.includes(name)}))})
  },
  onClearBrands(){ this.setData({selectedBrands:[],brandOptions:this.data.brandNames.map(name=>({name,selected:false}))}) },
  onCloseBrandSheet(){ if(!this.data.saving)this.setData({brandSheetVisible:false}) },
  onSaveBrands(){
    if(this.data.saving||!this.data.editingArtistId)return
    const id=this.data.editingArtistId, brands=[...this.data.selectedBrands], roles=[...this.data.selectedRoles]
    this.setData({saving:true})
    wx.cloud.callFunction({name:'manageArtistBrands',data:{action:'update',artistDocId:id,brands,roles},success:(res:any)=>{
      const r=res.result||{}; if(!r.success){wx.showToast({title:r.error||'保存失败',icon:'none'});return}
      const savedBrands=Array.isArray(r.brands)?r.brands:brands
      const savedRoles=Array.isArray(r.roles)?r.roles:roles
      const brandNames=Array.from(new Set([...this.data.brandNames,...savedBrands])).sort((a,b)=>a.localeCompare(b,'zh-CN'))
      this.setData({list:this.data.list.map(x=>x.id===id?{...x,brands:savedBrands,roles:savedRoles}:x),brandNames,brandOptions:brandNames.map(name=>({name,selected:savedBrands.includes(name)})),roleOptions:ROLE_OPTIONS.map(role=>({...role,selected:savedRoles.includes(role.key)})),brandSheetVisible:false})
      wx.showToast({title:'已更新',icon:'success'})
    },fail:()=>wx.showToast({title:'保存失败',icon:'none'}),complete:()=>this.setData({saving:false})} as any)
  },

  onOpenBatchRoles(){ if(!this.data.batchSelectedCount)return; this.setData({batchRoleSheetVisible:true,batchRoles:[],batchRoleOptions:ROLE_OPTIONS.map(x=>({...x,selected:false}))}) },
  onToggleBatchRole(e:WechatMiniprogram.TouchEvent){
    const role=String((e.currentTarget.dataset as any).role||'') as ArtistRole
    const batchRoles=this.data.batchRoles.includes(role)?this.data.batchRoles.filter(x=>x!==role):[...this.data.batchRoles,role]
    this.setData({batchRoles,batchRoleOptions:ROLE_OPTIONS.map(x=>({...x,selected:batchRoles.includes(x.key)}))})
  },
  onCloseBatchRoleSheet(){ if(!this.data.batchSaving)this.setData({batchRoleSheetVisible:false}) },
  onSaveBatchRoles(){
    if(this.data.batchSaving)return
    const ids=this.data.list.filter(x=>x.selected).map(x=>x.id); if(!ids.length)return
    const roles=[...this.data.batchRoles]
    this.setData({batchSaving:true})
    wx.cloud.callFunction({name:'manageArtistBrands',data:{action:'bulk_update_roles',artistDocIds:ids,roles},success:(res:any)=>{
      const r=res.result||{}; if(!r.success){wx.showToast({title:r.error||'批量保存失败',icon:'none'});return}
      const savedRoles=Array.isArray(r.roles)?r.roles:roles
      this.setData({list:this.data.list.map(x=>ids.includes(x.id)?{...x,roles:savedRoles,selected:false}:x),batchMode:false,batchSelectedCount:0,batchRoleSheetVisible:false})
      wx.showToast({title:`已更新 ${ids.length} 位`,icon:'success'})
    },fail:()=>wx.showToast({title:'批量保存失败',icon:'none'}),complete:()=>this.setData({batchSaving:false})} as any)
  },

  noop(){}, onBack(){wx.navigateBack()},
})
