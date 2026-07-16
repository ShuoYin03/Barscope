import { getThemeClass } from '../../utils/theme'

Page({
  data:{statusBarHeight:20,themeClass:'',list:[] as any[],loading:true,loadError:''},
  onLoad(){const app=getApp<IAppOption>();this.setData({statusBarHeight:app.globalData.statusBarHeight});this.loadList()},
  onShow(){this.setData({themeClass:getThemeClass()});this.loadList()},
  loadList(){this.setData({loading:true,loadError:''});wx.cloud.callFunction({name:'manageAlbumTypeCorrections',data:{action:'list',status:'pending'},success:(res:any)=>{const r=res.result||{};if(!r.success){this.setData({loading:false,loadError:r.error||'加载失败'});return}this.setData({list:r.list||[],loading:false})},fail:()=>this.setData({loading:false,loadError:'加载失败，请确认云函数已部署'})} as any)},
  decide(e:WechatMiniprogram.TouchEvent){const ds=e.currentTarget.dataset as any;const id=ds.id;const decision=ds.decision;if(!id)return;wx.showModal({title:decision==='approve'?'批准类型修改？':'拒绝类型修改？',content:decision==='approve'?'该专辑的类型标签会被更新为提交的类型。':'该申请会被关闭，专辑保持原类型。',confirmText:decision==='approve'?'批准':'拒绝',confirmColor:'#C94E25',success:(m)=>{if(!m.confirm)return;wx.showLoading({title:'处理中…',mask:true});wx.cloud.callFunction({name:'manageAlbumTypeCorrections',data:{action:'decide',id,decision},success:(res:any)=>{wx.hideLoading();const r=res.result||{};if(r.success){wx.showToast({title:decision==='approve'?'已批准':'已拒绝',icon:'success'});this.loadList()}else wx.showToast({title:r.error||'操作失败',icon:'none'})},fail:()=>{wx.hideLoading();wx.showToast({title:'网络错误',icon:'none'})}} as any)}})},
  onBack(){wx.navigateBack()}
})
