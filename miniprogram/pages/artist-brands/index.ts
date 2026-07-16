import { getThemeClass } from '../../utils/theme'

type ArtistRole = 'rapper' | 'producer' | 'label'
interface ArtistRow { id:string; artistId:string; artistName:string; picUrl:string; albumSize:number; brands:string[]; roles:ArtistRole[]; selected?:boolean }
interface BrandOption { name:string; selected:boolean }
interface RoleOption { key:ArtistRole; label:string; selected:boolean }
interface RoleSuggestion { _id:string; artistDocId:string; artistId:string; artistName:string; previousRoles:ArtistRole[]; roles:ArtistRole[] }

const ROLE_OPTIONS:{key:ArtistRole;label:string}[] = [
  { key:'rapper', label:'RAPPER' },
  { key:'producer', label:'PRODUCER' },
  { key:'label', label:'LABEL' },
]

Page({
  data:{
    statusBarHeight:20, themeClass:'', keyword:'', list:[] as ArtistRow[], rawList:[] as ArtistRow[], loading:true,
    unassignedOnly:false, unassignedCount:0,
    brandSheetVisible:false, editingArtistId:'', editingArtistName:'', brandNames:[] as string[], brandOptions:[] as BrandOption[], selectedBrands:[] as string[],
    roleOptions:ROLE_OPTIONS.map(x=>({...x,selected:false})) as RoleOption[], selectedRoles:[] as ArtistRole[], saving:false,
    batchMode:false, batchSelectedCount:0, batchRoleSheetVisible:false, batchRoles:[] as ArtistRole[], batchRoleOptions:ROLE_OPTIONS.map(x=>({...x,selected:false})) as RoleOption[], batchSaving:false,
    reviewSheetVisible:false, roleSuggestions:[] as RoleSuggestion[], reviewLoading:false, reviewWorking:'',
  },

  onLoad(){ const app=getApp<IAppOption>(); this.setData({statusBarHeight:app.globalData.statusBarHeight}); this.loadArtists(); this.loadRoleSuggestions() },
  onShow(){ this.setData({themeClass:getThemeClass()}) },

  applyListFilter(rawList:ArtistRow[], unassignedOnly=this.data.unassignedOnly){
    return unassignedOnly ? rawList.filter(x=>!Array.isArray(x.roles)||x.roles.length===0) : rawList
  },

  loadArtists(){
    this.setData({loading:true})
    const keyword=this.data.keyword.trim()
    const listCall=wx.cloud.callFunction({name:'getArtists',data:{keyword,limit:1000}}).catch(()=>({result:{success:false,list:[]}}))
    const allCall=keyword?wx.cloud.callFunction({name:'getArtists',data:{keyword:'',limit:1000}}).catch(()=>({result:{success:false,list:[]}})):listCall
    Promise.all([listCall,allCall]).then(async(results:any[])=>{
      const listResult=results[0]?.result||{}, allResult=results[1]?.result||{}
      let rawList:ArtistRow[]=(listResult.success?(listResult.list||[]):[]).map((x:any)=>({...x,roles:Array.isArray(x.roles)?x.roles:[],selected:false}))
      let allArtists:ArtistRow[]=(allResult.success?(allResult.list||[]):[]).map((x:any)=>({...x,roles:Array.isArray(x.roles)?x.roles:[]}))
      const brandNames=Array.from(new Set(allArtists.flatMap(x=>x.brands||[]).map(x=>String(x||'').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b,'zh-CN'))

      try {
        const ids=Array.from(new Set([...rawList.map(x=>x.id),...allArtists.map(x=>x.id)]))
        const roleRes:any=await wx.cloud.callFunction({name:'manageArtistBrands',data:{action:'get_roles_map',artistDocIds:ids}})
        const rolesMap=roleRes.result?.rolesMap||{}
        rawList=rawList.map(x=>({...x,roles:Array.isArray(rolesMap[x.id])?rolesMap[x.id]:x.roles}))
        allArtists=allArtists.map(x=>({...x,roles:Array.isArray(rolesMap[x.id])?rolesMap[x.id]:x.roles}))
      } catch(e) {}

      const unassignedCount=allArtists.filter(x=>!Array.isArray(x.roles)||x.roles.length===0).length
      this.setData({rawList,list:this.applyListFilter(rawList),brandNames,unassignedCount,loading:false,batchSelectedCount:0})
    }).catch(()=>{ this.setData({loading:false}); wx.showToast({title:'加载失败',icon:'none'}) })
  },

  onToggleUnassigned(){
    const unassignedOnly=!this.data.unassignedOnly
    this.setData({unassignedOnly,list:this.applyListFilter(this.data.rawList,unassignedOnly),batchMode:false,batchSelectedCount:0})
  },

  loadRoleSuggestions(){
    this.setData({reviewLoading:true})
    wx.cloud.callFunction({name:'manageArtistBrands',data:{action:'list_role_suggestions'},success:(res:any)=>{
      const r=res.result||{}
      this.setData({roleSuggestions:r.success?(r.list||[]):[],reviewLoading:false})
    },fail:()=>this.setData({reviewLoading:false})} as any)
  },
  onOpenReview(){ this.setData({reviewSheetVisible:true}); this.loadRoleSuggestions() },
  onCloseReview(){ if(!this.data.reviewWorking)this.setData({reviewSheetVisible:false}) },
  onReviewSuggestion(e:WechatMiniprogram.TouchEvent){
    const ds=e.currentTarget.dataset as any
    const id=String(ds.id||''), decision=String(ds.decision||'')
    if(!id||this.data.reviewWorking)return
    this.setData({reviewWorking:id})
    wx.cloud.callFunction({name:'manageArtistBrands',data:{action:'review_role_suggestion',suggestionId:id,decision},success:(res:any)=>{
      const r=res.result||{}
      if(!r.success){wx.showToast({title:r.error||'处理失败',icon:'none'});return}
      this.setData({roleSuggestions:this.data.roleSuggestions.filter(x=>x._id!==id)})
      this.loadArtists()
      wx.showToast({title:decision==='approve'?'已通过':'已拒绝',icon:'success'})
    },fail:()=>wx.showToast({title:'处理失败',icon:'none'}),complete:()=>this.setData({reviewWorking:''})} as any)
  },

  onSearch(e:WechatMiniprogram.Input){ this.setData({keyword:e.detail.value}); this.loadArtists() },
  onToggleBatchMode(){
    const batchMode=!this.data.batchMode
    const rawList=this.data.rawList.map(x=>({...x,selected:false}))
    this.setData({batchMode,batchSelectedCount:0,rawList,list:this.applyListFilter(rawList)})
  },
  onRowTap(e:WechatMiniprogram.TouchEvent){
    const id=String((e.currentTarget.dataset as any).id||'')
    if(this.data.batchMode){
      const rawList=this.data.rawList.map(x=>x.id===id?{...x,selected:!x.selected}:x)
      const list=this.applyListFilter(rawList)
      this.setData({rawList,list,batchSelectedCount:rawList.filter(x=>x.selected).length})
      return
    }
    this.openEditor(id)
  },
  openEditor(id:string){
    const artist=this.data.rawList.find(x=>x.id===id); if(!artist)return
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
      const rawList=this.data.rawList.map(x=>x.id===id?{...x,brands:savedBrands,roles:savedRoles}:x)
      const unassignedCount=Math.max(0,this.data.unassignedCount+((this.data.rawList.find(x=>x.id===id)?.roles||[]).length===0&&savedRoles.length>0?-1:0)+((this.data.rawList.find(x=>x.id===id)?.roles||[]).length>0&&savedRoles.length===0?1:0))
      this.setData({rawList,list:this.applyListFilter(rawList),unassignedCount,brandNames,brandOptions:brandNames.map(name=>({name,selected:savedBrands.includes(name)})),roleOptions:ROLE_OPTIONS.map(role=>({...role,selected:savedRoles.includes(role.key)})),brandSheetVisible:false})
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
    const ids=this.data.rawList.filter(x=>x.selected).map(x=>x.id); if(!ids.length)return
    const roles=[...this.data.batchRoles]
    this.setData({batchSaving:true})
    wx.cloud.callFunction({name:'manageArtistBrands',data:{action:'bulk_update_roles',artistDocIds:ids,roles},success:(res:any)=>{
      const r=res.result||{}; if(!r.success){wx.showToast({title:r.error||'批量保存失败',icon:'none'});return}
      const savedRoles=Array.isArray(r.roles)?r.roles:roles
      const rawList=this.data.rawList.map(x=>ids.includes(x.id)?{...x,roles:savedRoles,selected:false}:x)
      this.setData({rawList,list:this.applyListFilter(rawList),batchMode:false,batchSelectedCount:0,batchRoleSheetVisible:false})
      this.loadArtists()
      wx.showToast({title:`已更新 ${ids.length} 位`,icon:'success'})
    },fail:()=>wx.showToast({title:'批量保存失败',icon:'none'}),complete:()=>this.setData({batchSaving:false})} as any)
  },

  noop(){}, onBack(){wx.navigateBack()},
})