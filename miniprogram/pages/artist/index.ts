interface ArtistAlbum {
  id: string
  title: string
  year: number
  trackCount: number
  score: number
  coverUrl: string
  yearAnchor: string
}

interface Collaborator {
  key: string
  artistId: string
  name: string
  count: number
  collected: boolean
}

type ArtistRole = 'rapper' | 'producer' | 'label'
interface RoleOption { key: ArtistRole; label: string; selected: boolean }
const ROLE_OPTIONS:{key:ArtistRole;label:string}[] = [
  { key:'rapper', label:'RAPPER' },
  { key:'producer', label:'PRODUCER' },
  { key:'label', label:'LABEL' },
]

const BIO_PREVIEW_LENGTH = 150

function computeNameFit(name: string) {
  const len = String(name || '').length
  if (len > 17) return { nameFontSize: 54, nameLetterSpacing: 2 }
  if (len > 13) return { nameFontSize: 66, nameLetterSpacing: 4 }
  if (len > 10) return { nameFontSize: 76, nameLetterSpacing: 6 }
  if (len > 7) return { nameFontSize: 86, nameLetterSpacing: 8 }
  return { nameFontSize: 100, nameLetterSpacing: 10 }
}

function buildBioState(value: string) {
  const bio = String(value || '').trim()
  const hasLongBio = bio.length > BIO_PREVIEW_LENGTH
  return {
    briefDesc: bio,
    briefDescPreview: hasLongBio ? `${bio.slice(0, BIO_PREVIEW_LENGTH).trimEnd()}…` : bio,
    hasLongBio,
  }
}

import { getThemeClass } from '../../utils/theme'

Page({
  data: {
    statusBarHeight: 20,
    themeClass: '',
    artistName: '',
    nameFontSize: 100,
    nameLetterSpacing: 10,
    initial: '',
    bannerUrl: '',
    avatarUrl: '',
    roleLabel: '',
    roles: [] as ArtistRole[],
    brandLabel: '',
    roleTag: '',
    isArtistVerified: false,
    briefDesc: '',
    briefDescPreview: '',
    hasLongBio: false,
    bioExpanded: false,
    total: 0,
    avgScore: '–',
    yearRange: '',
    list: [] as ArtistAlbum[],
    years: [] as number[],
    activeYear: 0,
    scrollIntoView: '',
    collaborators: [] as Collaborator[],
    visibleCollaborators: [] as Collaborator[],
    collaboratorsExpanded: false,
    loading: true,
    notCollected: false,
    submitStatus: 'idle' as 'idle' | 'submitting' | 'submitted' | 'pending',
    roleSheetVisible: false,
    suggestedRoles: [] as ArtistRole[],
    roleOptions: ROLE_OPTIONS.map(x=>({...x,selected:false})) as RoleOption[],
    roleSuggestionSubmitting: false,
  },

  _artistId: '',

  onLoad(options: Record<string, string>) {
    const app = getApp<IAppOption>()
    const artistId = options.artistId || ''
    const artistName = decodeURIComponent(options.artistName || '')
    const initial = artistName[0] || '?'
    this._artistId = artistId
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, artistName, initial: initial.toUpperCase(), ...computeNameFit(artistName) })
    this._loadArtist(artistId)
    this._loadAlbums(artistId)
    this._loadCollaborators(artistId, artistName)
  },

  _loadArtist(artistId: string) {
    wx.cloud.callFunction({
      name: 'getArtist',
      data: { artistId },
      success: (res: any) => {
        const artist = res.result?.artist
        if (!artist) { this.setData({ notCollected: true, loading: false }); return }
        const bannerUrl = artist.heroImageUrl || artist.backgroundUrl || artist.coverUrl || artist.picUrl || artist.avatarUrl || ''
        const avatarUrl = artist.avatarUrl || artist.picUrl || artist.heroImageUrl || artist.backgroundUrl || artist.coverUrl || ''
        const bioState = buildBioState(artist.briefDesc || artist.description || artist.trans || '')
        const brandLabel = Array.isArray(artist.brands) ? artist.brands.filter(Boolean).join(' | ') : (artist.brand || '')
        const roles = Array.isArray(artist.roles) ? artist.roles.filter((x:string)=>ROLE_OPTIONS.some(r=>r.key===x)) : []
        const roleLabel = roles.map((x:string)=>String(x).toUpperCase()).join(' / ')
        const roleTag = [roleLabel, brandLabel].filter(Boolean).join(' | ')
        this.setData({ notCollected: false, bannerUrl, avatarUrl, roles, roleLabel, brandLabel, roleTag, isArtistVerified: !!artist.isArtistVerified, bioExpanded: false, ...bioState })
      },
    } as any)
  },

  onOpenRoleSuggest() {
    const suggestedRoles=[...this.data.roles]
    this.setData({
      roleSheetVisible:true,
      suggestedRoles,
      roleOptions:ROLE_OPTIONS.map(x=>({...x,selected:suggestedRoles.includes(x.key)})),
    })
  },
  onToggleSuggestedRole(e:WechatMiniprogram.TouchEvent) {
    const role=String((e.currentTarget.dataset as any).role||'') as ArtistRole
    if(!ROLE_OPTIONS.some(x=>x.key===role))return
    const suggestedRoles=this.data.suggestedRoles.includes(role)?this.data.suggestedRoles.filter(x=>x!==role):[...this.data.suggestedRoles,role]
    this.setData({suggestedRoles,roleOptions:ROLE_OPTIONS.map(x=>({...x,selected:suggestedRoles.includes(x.key)}))})
  },
  onCloseRoleSuggest(){ if(!this.data.roleSuggestionSubmitting)this.setData({roleSheetVisible:false}) },
  onSubmitRoleSuggestion(){
    if(this.data.roleSuggestionSubmitting)return
    this.setData({roleSuggestionSubmitting:true})
    wx.cloud.callFunction({
      name:'manageArtistBrands',
      data:{action:'submit_role_suggestion',artistId:this._artistId,artistName:this.data.artistName,roles:this.data.suggestedRoles},
      success:(res:any)=>{
        const r=res.result||{}
        if(!r.success){wx.showToast({title:r.error||'提交失败',icon:'none'});return}
        this.setData({roleSheetVisible:false})
        wx.showToast({title:'已提交管理员审核',icon:'success'})
      },
      fail:()=>wx.showToast({title:'提交失败',icon:'none'}),
      complete:()=>this.setData({roleSuggestionSubmitting:false}),
    } as any)
  },

  _loadCollaborators(artistId: string, artistName: string) {
    wx.cloud.callFunction({
      name: 'getArtistCollaborators',
      data: { artistId, artistName },
      success: (res: any) => {
        const result = res.result || {}
        const collaborators: Collaborator[] = result.success ? (result.list || []) : []
        this.setData({ collaborators, visibleCollaborators: collaborators.slice(0, 3), collaboratorsExpanded: false })
      },
      fail: () => this.setData({ collaborators: [], visibleCollaborators: [], collaboratorsExpanded: false }),
    } as any)
  },

  onSubmitArtist() {
    if (this.data.submitStatus !== 'idle') return
    this.setData({ submitStatus: 'submitting' })
    wx.cloud.callFunction({
      name: 'submitArtistRequest',
      data: { name: this.data.artistName },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ submitStatus: 'idle' }); wx.showToast({ title: r.error || '提交失败', icon: 'none' }); return }
        if (r.existed && r.status === 'approved') {
          wx.showToast({ title: '已收录，正在刷新', icon: 'none' })
          this.setData({ submitStatus: 'idle' })
          this._loadArtist(this._artistId)
          this._loadAlbums(this._artistId)
          this._loadCollaborators(this._artistId, this.data.artistName)
          return
        }
        if (r.existed) { this.setData({ submitStatus: 'pending' }); return }
        this.setData({ submitStatus: 'submitted' })
      },
      fail: () => { this.setData({ submitStatus: 'idle' }); wx.showToast({ title: '提交失败', icon: 'none' }) },
    } as any)
  },

  onShow() { this.setData({ themeClass: getThemeClass() }) },
  onBioToggle() { if (this.data.hasLongBio) this.setData({ bioExpanded: !this.data.bioExpanded }) },

  _loadAlbums(artistId: string) {
    wx.cloud.callFunction({
      name: 'getAlbums',
      data: { artistId, pageSize: 100 },
      success: (res: any) => {
        const result = res.result
        if (!result?.success) { this.setData({ loading: false }); return }
        const rawList: any[] = result.list || []
        const sortedRaw = rawList.slice().sort((a: any, b: any) => Number(b.releaseYear || 0) - Number(a.releaseYear || 0))
        const seenYears = new Set<number>()
        const list: ArtistAlbum[] = sortedRaw.map((a: any) => {
          const year = Number(a.releaseYear || 0)
          const firstOfYear = !!year && !seenYears.has(year)
          if (year) seenYears.add(year)
          return { id: a._id, title: a.title || '', year, trackCount: a.trackCount || 0, score: Math.round((a.avgScore || 0) * 10) / 10, coverUrl: a.coverUrl || '', yearAnchor: firstOfYear ? `career-year-${year}` : '' }
        })
        const scored = list.filter(a => a.score > 0)
        const avgScore = scored.length ? (scored.reduce((s, a) => s + a.score, 0) / scored.length).toFixed(1) : '–'
        const years = Array.from(seenYears).sort((a, b) => b - a)
        const yearRange = years.length ? (Math.min(...years) === Math.max(...years) ? String(Math.min(...years)) : `${Math.min(...years)}–${Math.max(...years)}`) : ''
        this.setData({ list, total: list.length, avgScore, yearRange, years, activeYear: years[0] || 0, loading: false })
      },
      fail: () => this.setData({ loading: false }),
    } as any)
  },

  onYearTap(e: WechatMiniprogram.TouchEvent) {
    const year = Number((e.currentTarget.dataset as any).year || 0)
    if (!year) return
    this.setData({ activeYear: year })
    const selector = `#career-year-${year}`
    wx.createSelectorQuery()
      .select(selector).boundingClientRect()
      .selectViewport().scrollOffset()
      .exec((res: any[]) => {
        const target = res?.[0]
        const viewport = res?.[1]
        if (!target || !viewport) return
        wx.pageScrollTo({ scrollTop: Math.max(0, Number(viewport.scrollTop || 0) + Number(target.top || 0) - 16), duration: 260 })
      })
  },
  onCollaboratorsMore() {
    const expanded = !this.data.collaboratorsExpanded
    this.setData({ collaboratorsExpanded: expanded, visibleCollaborators: expanded ? this.data.collaborators.slice(0, 10) : this.data.collaborators.slice(0, 3) })
  },
  onCollaboratorTap(e: WechatMiniprogram.TouchEvent) {
    const dataset = e.currentTarget.dataset as any
    const artistId = String(dataset.artistId || '')
    const artistName = String(dataset.artistName || '')
    const collected = dataset.collected === true || dataset.collected === 'true'
    if (artistId && collected) wx.navigateTo({ url: `/pages/artist/index?artistId=${encodeURIComponent(artistId)}&artistName=${encodeURIComponent(artistName)}` })
  },
  onBack() { wx.navigateBack() },
  onAlbumTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id
    wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
  },
  noop(){},
})