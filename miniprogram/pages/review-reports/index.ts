import { getThemeClass } from '../../utils/theme'

Page({
  data:{statusBarHeight:20,themeClass:'',list:[] as any[],loading:true,loadError:''},
  onLoad(){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight});this.loadList()},
  onShow(){this.setData({themeClass:getThemeClass()});this.loadList()},
  loadList(){this.setData({loading:true,loadError:''});wx.cloud.callFunction({name:'reviewModeration',data:{action:'list'},success:(res:any)=>{const r=res.result||{};if(!r.success){this.setData({loading:false,loadError:r.error||'加载失败'});return}this.setData({list:r.list||[],loading:false})},fail:()=>this.setData({loading:false,loadError:'加载失败，请确认云函数已部署'})} as any)},
  decide(e:WechatMiniprogram.TouchEvent){const ds=e.currentTarget.dataset as any;const id=ds.id;const decision=ds.decision;if(!id)return;wx.showModal({title:decision==='delete'?'删除该评论？':'保留该评论？',content:decision==='delete'?'该评论及其点赞、回复会被永久删除，专辑评分会重新计算。':'该举报会被标记为已处理，评论保持不变。',confirmText:decision==='delete'?'删除':'保留',confirmColor:'#2D6FE0',success:(m)=>{if(!m.confirm)return;wx.showLoading({title:'处理中…',mask:true});wx.cloud.callFunction({name:'reviewModeration',data:{action:'decide',id,decision},success:(res:any)=>{wx.hideLoading();const r=res.result||{};if(r.success){wx.showToast({title:decision==='delete'?'已删除':'已保留',icon:'success'});this.loadList()}else wx.showToast({title:r.error||'操作失败',icon:'none'})},fail:()=>{wx.hideLoading();wx.showToast({title:'网络错误',icon:'none'})}} as any)}})},
  onBack(){wx.navigateBack()}
})
