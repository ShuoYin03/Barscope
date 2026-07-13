import { getThemeClass } from '../../utils/theme'

interface ArtistRow { id:string; artistId:string; artistName:string; picUrl:string; albumSize:number; brands:string[] }
interface BrandOption { name:string; selected:boolean }

Page({
  data:{
    statusBarHeight:20,
    themeClass:'',
    keyword:'',
    list:[] as ArtistRow[],
    loading:true,
    brandSheetVisible:false,
    editingArtistId:'',
    editingArtistName:'',
    brandNames:[] as string[],
    brandOptions:[] as BrandOption[],
    selectedBrands:[] as string[],
    saving:false,
  },

  onLoad(){
    const app=getApp<IAppOption>()
    this.setData({statusBarHeight:app.globalData.statusBarHeight})
    this.loadArtists()
  },

  onShow(){this.setData({themeClass:getThemeClass()})},

  loadArtists(){
    this.setData({loading:true})
    const keyword=this.data.keyword.trim()
    const listCall=wx.cloud.callFunction({name:'getArtists',data:{keyword,limit:1000}}).catch(()=>({result:{success:false,list:[]}}))
    const brandCall=keyword
      ? wx.cloud.callFunction({name:'getArtists',data:{keyword:'',limit:1000}}).catch(()=>({result:{success:false,list:[]}}))
      : listCall

    Promise.all([listCall,brandCall]).then((results:any[])=>{
      const listResult=results[0]?.result||{}
      const brandResult=results[1]?.result||{}
      const list:ArtistRow[]=listResult.success?(listResult.list||[]):[]
      const allArtists:ArtistRow[]=brandResult.success?(brandResult.list||[]):[]
      const brandNames=Array.from(
        new Set(allArtists.flatMap(x=>x.brands||[]).map(x=>String(x||'').trim()).filter(Boolean))
      ).sort((a,b)=>a.localeCompare(b,'zh-CN'))

      this.setData({list,brandNames,loading:false})
    }).catch(()=>{
      this.setData({loading:false})
      wx.showToast({title:'加载失败',icon:'none'})
    })
  },

  onSearch(e:WechatMiniprogram.Input){
    this.setData({keyword:e.detail.value})
    this.loadArtists()
  },

  onEdit(e:WechatMiniprogram.TouchEvent){
    const id=String((e.currentTarget.dataset as any).id||'')
    const artist=this.data.list.find(x=>x.id===id)
    if(!artist)return
    const selectedBrands=[...(artist.brands||[])]
    const brandNames=Array.from(new Set([...this.data.brandNames,...selectedBrands])).sort((a,b)=>a.localeCompare(b,'zh-CN'))
    this.setData({
      brandSheetVisible:true,
      editingArtistId:id,
      editingArtistName:artist.artistName,
      selectedBrands,
      brandNames,
      brandOptions:brandNames.map(name=>({name,selected:selectedBrands.includes(name)})),
    })
  },

  onToggleBrand(e:WechatMiniprogram.TouchEvent){
    const brand=String((e.currentTarget.dataset as any).brand||'')
    if(!brand)return
    const selectedBrands=this.data.selectedBrands.includes(brand)
      ? this.data.selectedBrands.filter(x=>x!==brand)
      : [...this.data.selectedBrands,brand].slice(0,10)
    this.setData({
      selectedBrands,
      brandOptions:this.data.brandNames.map(name=>({name,selected:selectedBrands.includes(name)})),
    })
  },

  onClearBrands(){
    this.setData({
      selectedBrands:[],
      brandOptions:this.data.brandNames.map(name=>({name,selected:false})),
    })
  },

  onCloseBrandSheet(){
    if(!this.data.saving)this.setData({brandSheetVisible:false})
  },

  onSaveBrands(){
    if(this.data.saving||!this.data.editingArtistId)return
    const id=this.data.editingArtistId
    const brands=this.data.selectedBrands
    this.setData({saving:true})
    wx.cloud.callFunction({
      name:'manageArtistBrands',
      data:{action:'update',artistDocId:id,brands},
      success:(res:any)=>{
        const r=res.result||{}
        if(!r.success){wx.showToast({title:r.error||'保存失败',icon:'none'});return}
        const savedBrands=r.brands||[]
        const brandNames=Array.from(new Set([...this.data.brandNames,...savedBrands])).sort((a,b)=>a.localeCompare(b,'zh-CN'))
        this.setData({
          list:this.data.list.map(x=>x.id===id?{...x,brands:savedBrands}:x),
          brandNames,
          brandOptions:brandNames.map(name=>({name,selected:savedBrands.includes(name)})),
          brandSheetVisible:false,
        })
        wx.showToast({title:'已更新',icon:'success'})
      },
      fail:()=>wx.showToast({title:'保存失败',icon:'none'}),
      complete:()=>this.setData({saving:false}),
    } as any)
  },

  noop(){},
  onBack(){wx.navigateBack()},
})