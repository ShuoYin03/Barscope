interface ArtistAlbum {
  id:         string
  title:      string
  year:       number
  trackCount: number
  score:      number
  coverUrl:   string
  yearAnchor: string
}

interface Collaborator {
  artistId: string
  name: string
  count: number
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

function collectCollaborators(rawList: any[], currentArtistId: string, currentArtistName: string): Collaborator[] {
  const counts = new Map<string, Collaborator>()
  const currentId = String(currentArtistId || '')
  const currentNameKey = normalizeName(currentArtistName)

  const add = (id: any, name: any) => {
    const artistId = String(id || '').trim()
    const artistName = String(name || '').trim()
    if (!artistId || !artistName) return
    if (artistId === currentId || normalizeName(artistName) === currentNameKey) return
    const key = artistId
    const existing = counts.get(key)
    if (existing) existing.count += 1
    else counts.set(key, { artistId, name: artistName, count: 1 })
  }

  rawList.forEach((album: any) => {
    const seenThisAlbum = new Set<string>()
    const addOnce = (id: any, name: any) => {
      const key = String(id || '').trim()
      if (!key || seenThisAlbum.has(key)) return
      seenThisAlbum.add(key)
      add(id, name)
    }

    if (Array.isArray(album.collaboratorArtists)) {
      album.collaboratorArtists.forEach((artist: any) => addOnce(artist?.id || artist?.artistId, artist?.name || artist?.artistName))
    }

    const ids = Array.isArray(album.collaboratorArtistIds) ? album.collaboratorArtistIds : []
    const names = Array.isArray(album.collaboratorArtistNames) ? album.collaboratorArtistNames : []
    ids.forEach((id: any, index: number) => addOnce(id, names[index]))

    // Older records may only keep artistIds and the slash-separated artist string.
    // Only pair these when the array lengths match so we never create an incorrect link.
    const artistIds = Array.isArray(album.artistIds) ? album.artistIds.map(String) : []
    const artistNames = String(album.artist || '').split('/').map((name: string) => name.trim()).filter(Boolean)
    if (artistIds.length && artistIds.length === artistNames.length) {
      artistIds.forEach((id: string, index: number) => addOnce(id, artistNames[index]))
    }
  })

  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 10)
}

import { getThemeClass } from '../../utils/theme'

Page({
  data: {
    statusBarHeight: 20,
    themeClass:      '',
    artistName:      '',
    initial:         '',
    bannerUrl:       '',
    avatarUrl:       '',
    briefDesc:       '',
    briefDescPreview:'',
    hasLongBio:      false,
    bioExpanded:     false,
    total:           0,
    avgScore:        '–',
    yearRange:       '',
    list:            [] as ArtistAlbum[],
    years:           [] as number[],
    activeYear:      0,
    scrollIntoView:  '',
    collaborators:   [] as Collaborator[],
    loading:         true,
    notCollected:    false,
    submitStatus:    'idle' as 'idle' | 'submitting' | 'submitted' | 'pending',
  },

  _artistId: '',

  onLoad(options: Record<string, string>) {
    const app = getApp<IAppOption>()
    const artistId   = options.artistId   || ''
    const artistName = decodeURIComponent(options.artistName || '')
    const initial    = (artistName.match(/[A-Za-z]/) ? artistName[0] : artistName[0]) || '?'

    this._artistId = artistId
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      artistName,
      initial: initial.toUpperCase(),
    })

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
        if (!r.success) {
          this.setData({ submitStatus: 'idle' })
          wx.showToast({ title: r.error || '提交失败', icon: 'none' })
          return
        }
        if (r.existed && r.status === 'approved') {
          wx.showToast({ title: '已收录，正在刷新', icon: 'none' })
          this.setData({ submitStatus: 'idle' })
          this._loadArtist(this._artistId)
          this._loadAlbums(this._artistId)
          return
        }
        if (r.existed) {
          this.setData({ submitStatus: 'pending' })
          return
        }
        this.setData({ submitStatus: 'submitted' })
      },
      fail: () => {
        this.setData({ submitStatus: 'idle' })
        wx.showToast({ title: '提交失败', icon: 'none' })
      },
    } as any)
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  onBioToggle() {
    if (!this.data.hasLongBio) return
    this.setData({ bioExpanded: !this.data.bioExpanded })
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
            id:         a._id,
            title:      a.title       || '',
            year,
            trackCount: a.trackCount  || 0,
            score:      Math.round((a.avgScore || 0) * 10) / 10,
            coverUrl:   a.coverUrl    || '',
            yearAnchor: firstOfYear ? `career-year-${year}` : '',
          }
        })

        const scored = list.filter(a => a.score > 0)
        const avgScore = scored.length
          ? (scored.reduce((s, a) => s + a.score, 0) / scored.length).toFixed(1)
          : '–'

        const years = Array.from(seenYears).sort((a, b) => b - a)
        const yearRange = years.length
          ? (Math.min(...years) === Math.max(...years)
              ? String(Math.min(...years))
              : `${Math.min(...years)}–${Math.max(...years)}`)
          : ''
        const collaborators = collectCollaborators(rawList, artistId, this.data.artistName)

        this.setData({
          list,
          total: list.length,
          avgScore,
          yearRange,
          years,
          activeYear: years[0] || 0,
          collaborators,
          loading: false,
        })
      },
      fail: () => this.setData({ loading: false }),
    } as any)
  },

  onYearTap(e: WechatMiniprogram.TouchEvent) {
    const year = Number((e.currentTarget.dataset as any).year || 0)
    if (!year) return
    this.setData({ activeYear: year, scrollIntoView: `career-year-${year}` })
  },

  onCollaboratorTap(e: WechatMiniprogram.TouchEvent) {
    const dataset = e.currentTarget.dataset as any
    const artistId = String(dataset.artistId || '')
    const artistName = String(dataset.artistName || '')
    if (!artistId) return
    wx.navigateTo({ url: `/pages/artist/index?artistId=${encodeURIComponent(artistId)}&artistName=${encodeURIComponent(artistName)}` })
  },

  onBack() {
    wx.navigateBack()
  },

  onAlbumTap(e: WechatMiniprogram.TouchEvent) {
    const id = (e.currentTarget.dataset as { id: string }).id
    wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
  },
})