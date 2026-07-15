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
  artistId: string
  name: string
  count: number
  collected: boolean
}

const BIO_PREVIEW_LENGTH = 150

function buildBioState(value: string) {
  const bio = String(value || '').trim()
  const hasLongBio = bio.length > BIO_PREVIEW_LENGTH
  return {
    briefDesc: bio,
    briefDescPreview: hasLongBio ? `${bio.slice(0, BIO_PREVIEW_LENGTH).trimEnd()}…` : bio,
    hasLongBio,
  }
}

function normalizeName(value: any) {
  return String(value || '').trim().toLowerCase().replace(/[\s._\-·'’/]/g, '')
}

// Full-career collaborator aggregation.
// Primary source: every album -> every track -> guests (Featuring).
// Compatibility fallback: when an older album has no track-level guests, use the
// album-level featuringGuests summary that was generated from its tracks.
// Nothing is truncated here; Top 10 is applied only after library matching + sorting.
function collectTrackCollaborators(rawList: any[], currentArtistId: string, currentArtistName: string): Collaborator[] {
  const counts = new Map<string, Collaborator>()
  const currentId = String(currentArtistId || '').trim()
  const currentNameKey = normalizeName(currentArtistName)

  const addCount = (id: any, rawName: any, increment = 1) => {
    const artistId = String(id || '').trim()
    const name = String(rawName || '').trim()
    if (!artistId || !name || increment <= 0) return
    if (artistId === currentId || normalizeName(name) === currentNameKey) return
    const existing = counts.get(artistId)
    if (existing) existing.count += increment
    else counts.set(artistId, { artistId, name, count: increment, collected: false })
  }

  rawList.forEach((album: any) => {
    const tracks = Array.isArray(album.tracks) ? album.tracks : []
    let trackGuestAppearances = 0

    tracks.forEach((track: any) => {
      const seenThisTrack = new Set<string>()
      const guests = Array.isArray(track.guests) ? track.guests : []

      guests.forEach((guest: any) => {
        const id = String(guest?.id || guest?.artistId || '').trim()
        const name = String(guest?.name || guest?.artistName || '').trim()
        if (!id || !name || seenThisTrack.has(id)) return
        if (id === currentId || normalizeName(name) === currentNameKey) return
        seenThisTrack.add(id)
        addCount(id, name, 1)
        trackGuestAppearances += 1
      })
    })

    // Some older synced records keep the correct Featuring counts only in this summary.
    // Use it only when no track-level guest data exists for this album to avoid double counting.
    if (trackGuestAppearances === 0 && Array.isArray(album.featuringGuests)) {
      album.featuringGuests.forEach((guest: any) => {
        addCount(guest?.id || guest?.artistId, guest?.name || guest?.artistName, Number(guest?.count || 1))
      })
    }
  })

  return Array.from(counts.values())
}

function sortCollaborators(list: Collaborator[]) {
  return list.slice().sort((a, b) =>
    b.count - a.count ||
    Number(b.collected) - Number(a.collected) ||
    a.name.localeCompare(b.name)
  )
}

import { getThemeClass } from '../../utils/theme'

Page({
  data: {
    statusBarHeight: 20,
    themeClass: '',
    artistName: '',
    initial: '',
    bannerUrl: '',
    avatarUrl: '',
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
  },

  _artistId: '',

  onLoad(options: Record<string, string>) {
    const app = getApp<IAppOption>()
    const artistId = options.artistId || ''
    const artistName = decodeURIComponent(options.artistName || '')
    const initial = artistName[0] || '?'
    this._artistId = artistId
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, artistName, initial: initial.toUpperCase() })
    this._loadArtist(artistId)
    this._loadAlbums(artistId)
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
        this.setData({ notCollected: false, bannerUrl, avatarUrl, bioExpanded: false, ...bioState })
      },
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
          return
        }
        if (r.existed) { this.setData({ submitStatus: 'pending' }); return }
        this.setData({ submitStatus: 'submitted' })
      },
      fail: () => { this.setData({ submitStatus: 'idle' }); wx.showToast({ title: '提交失败', icon: 'none' }) },
    } as any)
  },

  onShow() { this.setData({ themeClass: getThemeClass() }) },

  onBioToggle() {
    if (!this.data.hasLongBio) return
    this.setData({ bioExpanded: !this.data.bioExpanded })
  },

  _applyCollaborators(rawCollaborators: Collaborator[]) {
    const fallback = sortCollaborators(rawCollaborators).slice(0, 10)
    if (!rawCollaborators.length) {
      this.setData({ collaborators: [], visibleCollaborators: [], collaboratorsExpanded: false })
      return
    }

    wx.cloud.callFunction({
      name: 'getArtistAvatars',
      data: { artistIds: rawCollaborators.map(item => item.artistId) },
      success: (res: any) => {
        const libraryMap = new Map<string, boolean>()
        const rows = res.result?.success ? (res.result.list || []) : []
        rows.forEach((row: any) => libraryMap.set(String(row.artistId), !!row.collected))
        const ranked = sortCollaborators(rawCollaborators.map(item => ({
          ...item,
          collected: libraryMap.get(item.artistId) === true,
        }))).slice(0, 10)
        this.setData({ collaborators: ranked, visibleCollaborators: ranked.slice(0, 3), collaboratorsExpanded: false })
      },
      fail: () => this.setData({ collaborators: fallback, visibleCollaborators: fallback.slice(0, 3), collaboratorsExpanded: false }),
    } as any)
  },

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
          return {
            id: a._id,
            title: a.title || '',
            year,
            trackCount: a.trackCount || 0,
            score: Math.round((a.avgScore || 0) * 10) / 10,
            coverUrl: a.coverUrl || '',
            yearAnchor: firstOfYear ? `career-year-${year}` : '',
          }
        })

        const scored = list.filter(a => a.score > 0)
        const avgScore = scored.length ? (scored.reduce((s, a) => s + a.score, 0) / scored.length).toFixed(1) : '–'
        const years = Array.from(seenYears).sort((a, b) => b - a)
        const yearRange = years.length
          ? (Math.min(...years) === Math.max(...years) ? String(Math.min(...years)) : `${Math.min(...years)}–${Math.max(...years)}`)
          : ''

        this.setData({
          list,
          total: list.length,
          avgScore,
          yearRange,
          years,
          activeYear: years[0] || 0,
          loading: false,
        })

        // Important: aggregate the entire career first. No Top 10 truncation happens before this point.
        this._applyCollaborators(collectTrackCollaborators(rawList, artistId, this.data.artistName))
      },
      fail: () => this.setData({ loading: false }),
    } as any)
  },

  onYearTap(e: WechatMiniprogram.TouchEvent) {
    const year = Number((e.currentTarget.dataset as any).year || 0)
    if (!year) return
    this.setData({ activeYear: year, scrollIntoView: `career-year-${year}` })
  },

  onCollaboratorsMore() {
    const expanded = !this.data.collaboratorsExpanded
    this.setData({
      collaboratorsExpanded: expanded,
      visibleCollaborators: expanded ? this.data.collaborators.slice(0, 10) : this.data.collaborators.slice(0, 3),
    })
  },

  onCollaboratorTap(e: WechatMiniprogram.TouchEvent) {
    const dataset = e.currentTarget.dataset as any
    const artistId = String(dataset.artistId || '')
    const artistName = String(dataset.artistName || '')
    const collected = dataset.collected === true || dataset.collected === 'true'
    if (!artistId || !collected) return
    wx.navigateTo({ url: `/pages/artist/index?artistId=${encodeURIComponent(artistId)}&artistName=${encodeURIComponent(artistName)}` })
  },

  onBack() { wx.navigateBack() },

  onAlbumTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id
    wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
  },
})