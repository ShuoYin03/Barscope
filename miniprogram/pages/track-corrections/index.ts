import { getThemeClass } from '../../utils/theme'
Page({
 data:{statusBarHeight:20,topbarHeight:64,themeClass:'',list:[] as any[],loading:true,operating:''},
 onLoad(){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight,topbarHeight:app.globalData.topbarHeight});this.load()},
 onShow(){this.setData({themeClass:getThemeClass()})},
 onBack(){wx.navigateBack()},
 load(){this.setData({loading:true});wx.cloud.callFunction({name:'manageTrackCorrections',data:{action:'list',status:'pending'},success:(res:any)=>{const r=res.result||{};this.setData({list:r.success?(r.list||[]):[],loading:false})},fail:()=>this.setData({loading:false})} as any)},
 approve(e:WechatMiniprogram.TouchEvent){const id=String((e.currentTarget.dataset as any).id||'');if(!id||this.data.operating)return;wx.showModal({title:'通过曲目修改？',content:'通过后将立即更新正式专辑曲目。',confirmText:'通过',confirmColor:'#D45124',success:m=>{if(!m.confirm)return;this.run('approve',id)}})},
 reject(e:WechatMiniprogram.TouchEvent){const id=String((e.currentTarget.dataset as any).id||'');if(!id||this.data.operating)return;wx.showModal({title:'驳回申请？',editable:true,placeholderText:'可填写驳回原因',confirmText:'驳回',success:m=>{if(!m.confirm)return;this.run('reject',id,(m as any).content||'')}})},
 run(action:string,id:string,adminNote=''){this.setData({operating:id});wx.cloud.callFunction({name:'manageTrackCorrections',data:{action,id,adminNote},success:(res:any)=>{const r=res.result||{};if(!r.success){wx.showToast({title:r.error||'操作失败',icon:'none'});return}wx.showToast({title:action==='approve'?'已通过':'已驳回',icon:'success'});this.load()},fail:()=>wx.showToast({title:'网络错误',icon:'none'}),complete:()=>this.setData({operating:''})} as any)}
})
