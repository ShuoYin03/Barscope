interface Artist {
  _id: string
  artistId: number
  artistName: string
  picUrl: string
  albumSize: number
  approvedAlbumCount: number
  hiddenAlbumCount: number
  fansSize: number
}

interface Album {
  _id: string
  title: string
  artist: string
  primaryArtist: string
  releaseYear: number
  coverUrl: string
  approved: boolean
  avgScore: number
  reviewCount: number
  trackCount: number
  selected?: boolean
}

interface LetterCount { letter: string; count: number }

interface OwnerPick { artistId: string; artistName: string; picUrl: string; selected?: boolean }

interface DuplicateSample {
  key: string
  keep: { _id: string; title: string; artist: string; approved: boolean; reviewCount: number }
  remove: Array<{ _id: string; title: string; artist: string; approved: boolean; reviewCount: number }>
}

interface CleanupPreview {
  scanned: number
  duplicateGroups: number
  wouldRemove: number
  samples: DuplicateSample[]
}

import { getThemeClass } from '../../utils/theme'

let _searchTimer: any = null
let _titleSearchTimer: any = null
let _ownerSearchTimer: any = null
let _allSearchTimer: any = null

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    view: 'artists' as 'artists' | 'albums',
    searchMode: 'artist' as 'artist' | 'title' | 'all' | 'multi',
    artistList: [] as Artist[],
    artistLoading: false,
    artistHasMore: false,
    artistPage: 1,
    artistPageSize: 30,
    artistKeyword: '',
    titleKeyword: '',
    titleResults: [] as Album[],
    titleLoading: false,
    cleanupLoading: false,
    cleanupPreview: null as CleanupPreview | null,
    cleanupResult: null as any,
    selectedArtist: null as Artist | null,
    albumList: [] as Album[],
    albumLoading: false,
    toggling: {} as Record<string, boolean>,

    allLetters: [] as LetterCount[],
    allActiveLetter: '',
    allSearchKeyword: '',
    allSearching: false,
    allList: [] as Album[],
    allLoading: false,
    allPage: 1,
    allPageSize: 60,
    allTotal: 0,
    allHasMore: false,
    allSelectMode: false,
    allSelectedCount: 0,
    allBatchWorking: false,
    backfilling: false,
    backfillDone: 0,

    multiList: [] as Album[],
    multiLoading: false,
    multiPage: 1,
    multiPageSize: 60,
    multiTotal: 0,
    multiHasMore: false,
    multiSelectMode: false,
    multiSelectedCount: 0,
    multiReindexing: false,
    multiReindexDone: 0,

    ownerPickerVisible: false,
    ownerPickerAlbumCount: 0,
    ownerPickerKeyword: '',
    ownerPickerResults: [] as OwnerPick[],
    ownerPickerSelected: [] as OwnerPick[],
    ownerApplyWorking: false,

    resyncWorking: false,
    resyncDone: 0,
    resyncTotal: 0,
    resyncFailed: 0,
  },

  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
    })
    this._loadArtists(1)
  },

  onShow() {
    this.setData({ themeClass: getThemeClass() })
  },

  onBack() {
    if (this.data.view === 'albums') this.setData({ view: 'artists', selectedArtist: null, albumList: [] })
    else wx.navigateBack()
  },

  _loadArtists(page: number) {
    if (page > 1) return
    this.setData({ artistLoading: true })
    wx.cloud.callFunction({
      name: 'getArtists',
      data: {
        keyword: this.data.artistKeyword,
        limit: 1000,
      },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ artistLoading: false }); return }
        this.setData({
          artistList: (r.list || []).map((item: any) => ({
            _id: item.id,
            artistId: Number(item.artistId || 0),
            artistName: item.artistName || '',
            picUrl: item.picUrl || '',
            albumSize: Number(item.albumSize || 0),
            approvedAlbumCount: Number(item.approvedAlbumCount || 0),
            hiddenAlbumCount: Number(item.hiddenAlbumCount || 0),
            fansSize: Number(item.fansSize || 0),
          })),
          artistPage: 1,
          artistHasMore: false,
          artistLoading: false,
        })
      },
      fail: () => this.setData({ artistLoading: false }),
    })
  },

  onArtistSearch(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value || ''
    this.setData({ artistKeyword: keyword, artistList: [], artistPage: 1 })
    clearTimeout(_searchTimer)
    _searchTimer = setTimeout(() => this._loadArtists(1), 400)
  },

  onSearchModeTap(e: WechatMiniprogram.TouchEvent) {
    const mode = (e.currentTarget.dataset as { mode: 'artist' | 'title' | 'all' | 'multi' }).mode
    if (mode === this.data.searchMode) return
    this.setData({ searchMode: mode })
    if (mode === 'all' && !this.data.allLetters.length) this._loadLetterCounts()
    if (mode === 'multi' && !this.data.multiList.length) this._loadMultiArtistAlbums(1)
  },

  // ── 多人合作专辑 ──────────────────────────────────────────────────────
  _loadMultiArtistAlbums(page: number) {
    this.setData({ multiLoading: true })
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'list_multi_artist_albums', page, pageSize: this.data.multiPageSize },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ multiLoading: false }); return }
        const incoming = (r.list || []) as Album[]
        const newList = page === 1 ? incoming : [...this.data.multiList, ...incoming]
        this.setData({
          multiList: newList,
          multiTotal: r.total || 0,
          multiPage: page,
          multiHasMore: newList.length < (r.total || 0),
          multiLoading: false,
        })
      },
      fail: () => this.setData({ multiLoading: false }),
    })
  },

  onMultiReachBottom() {
    if (this.data.searchMode !== 'multi' || !this.data.multiHasMore || this.data.multiLoading) return
    this._loadMultiArtistAlbums(this.data.multiPage + 1)
  },


  _selectedAlbums() {
    return this.data.searchMode === 'multi'
      ? this.data.multiList.filter(a => a.selected)
      : this.data.allList.filter(a => a.selected)
  },

  _clearBatchSelection() {
    this.setData({
      allSelectedCount: 0,
      multiSelectedCount: 0,
      allList: this.data.allList.map(a => ({ ...a, selected: false })),
      multiList: this.data.multiList.map(a => ({ ...a, selected: false })),
    })
  },

  onToggleMultiSelectMode() {
    const multiSelectMode = !this.data.multiSelectMode
    this.setData({
      multiSelectMode,
      multiList: this.data.multiList.map(a => ({ ...a, selected: false })),
      multiSelectedCount: 0,
    })
  },

  onMultiCardTap(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.multiSelectMode) return
    const id = (e.currentTarget.dataset as { id: string }).id
    const multiList = this.data.multiList.map(a => a._id === id ? { ...a, selected: !a.selected } : a)
    this.setData({ multiList, multiSelectedCount: multiList.filter(a => a.selected).length })
  },

  onMultiSelectAll() {
    const shouldSelect = this.data.multiSelectedCount === 0
    const multiList = this.data.multiList.map(a => ({ ...a, selected: shouldSelect }))
    this.setData({ multiList, multiSelectedCount: shouldSelect ? multiList.length : 0 })
  },

  onMultiBatchShow() { this._batchToggleApproved(true) },
  onMultiBatchHide() { this._batchToggleApproved(false) },
  onMultiBatchOwnership() { this.onAllBatchOwnership() },
  onMultiBatchResync() { this.onAllBatchResync() },

  onRebuildMultiArtistIndex() {
    if (this.data.multiReindexing) return
    this.setData({ multiReindexing: true, multiReindexDone: 0 })
    this._runMultiReindexStep(0)
  },

  _runMultiReindexStep(skip: number) {
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'rebuild_multi_artist_index', skip },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) {
          this.setData({ multiReindexing: false })
          wx.showToast({ title: r.error || '扫描失败', icon: 'none' })
          return
        }
        this.setData({ multiReindexDone: r.processed || 0 })
        if (r.done) {
          this.setData({ multiReindexing: false, multiList: [], multiPage: 1 })
          wx.showToast({ title: `已识别 ${r.multiTotal || 0} 张`, icon: 'success' })
          this._loadMultiArtistAlbums(1)
          return
        }
        this._runMultiReindexStep(r.nextSkip || 0)
      },
      fail: () => {
        this.setData({ multiReindexing: false })
        wx.showToast({ title: '网络错误', icon: 'none' })
      },
    } as any)
  },

  // ── 全部专辑：字母表浏览 + 批量操作 ──────────────────────────────────────
  _loadLetterCounts() {
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'album_letter_counts' },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) return
        const allLetters: LetterCount[] = (r.counts || []).map((x: any) => ({ letter: x.letter, count: x.total || 0 }))
        const firstNonEmpty = allLetters.find(x => x.count > 0)
        const letter = this.data.allActiveLetter || (firstNonEmpty ? firstNonEmpty.letter : 'A')
        this.setData({ allLetters, allActiveLetter: letter })
        this._loadAllAlbums(letter, 1)
      },
    })
  },

  onAllLetterTap(e: WechatMiniprogram.TouchEvent) {
    const letter = (e.currentTarget.dataset as { letter: string }).letter
    if (!letter || letter === this.data.allActiveLetter) return
    this.setData({ allActiveLetter: letter, allSearchKeyword: '', allSearching: false, allList: [], allPage: 1, allHasMore: false })
    this._loadAllAlbums(letter, 1)
  },

  onAllSearch(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value || ''
    this.setData({ allSearchKeyword: keyword })
    clearTimeout(_allSearchTimer)
    _allSearchTimer = setTimeout(() => this._searchAllAlbums(keyword), 400)
  },

  _searchAllAlbums(keyword: string) {
    const kw = keyword.trim()
    if (!kw) {
      this.setData({ allSearching: false, allList: [], allPage: 1, allHasMore: false })
      this._loadAllAlbums(this.data.allActiveLetter, 1)
      return
    }
    this.setData({ allSearching: true, allLoading: true })
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'search_admin_albums', keyword: kw },
      success: (res: any) => {
        const r = res.result || {}
        const list = r.success ? (r.list || []) : []
        this.setData({ allList: list, allTotal: list.length, allHasMore: false, allLoading: false })
      },
      fail: () => this.setData({ allLoading: false }),
    })
  },

  _loadAllAlbums(letter: string, page: number) {
    this.setData({ allLoading: true })
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'list_all_albums', letter, page, pageSize: this.data.allPageSize },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ allLoading: false }); return }
        const incoming = (r.list || []) as Album[]
        const newList = page === 1 ? incoming : [...this.data.allList, ...incoming]
        this.setData({
          allList: newList,
          allTotal: r.total || 0,
          allPage: page,
          allHasMore: newList.length < (r.total || 0),
          allLoading: false,
        })
      },
      fail: () => this.setData({ allLoading: false }),
    })
  },

  onAllReachBottom() {
    if (this.data.searchMode !== 'all' || this.data.allSearching || !this.data.allHasMore || this.data.allLoading) return
    this._loadAllAlbums(this.data.allActiveLetter, this.data.allPage + 1)
  },

  onToggleAllSelectMode() {
    const allSelectMode = !this.data.allSelectMode
    const allList = this.data.allList.map(a => ({ ...a, selected: false }))
    this.setData({ allSelectMode, allList, allSelectedCount: 0 })
  },

  onAllCardTap(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.allSelectMode) return
    const id = (e.currentTarget.dataset as { id: string }).id
    const allList = this.data.allList.map(a => a._id === id ? { ...a, selected: !a.selected } : a)
    this.setData({ allList, allSelectedCount: allList.filter(a => a.selected).length })
  },

  onAllSelectAll() {
    const shouldSelect = this.data.allSelectedCount === 0
    const allList = this.data.allList.map(a => ({ ...a, selected: shouldSelect }))
    this.setData({ allList, allSelectedCount: shouldSelect ? allList.length : 0 })
  },

  onAllBatchShow() { this._batchToggleApproved(true) },
  onAllBatchHide() { this._batchToggleApproved(false) },

  _batchToggleApproved(approved: boolean) {
    if (this.data.allBatchWorking) return
    const ids = this._selectedAlbums().map(a => a._id)
    if (!ids.length) { wx.showToast({ title: '请先选择专辑', icon: 'none' }); return }
    wx.showModal({
      title: approved ? `显示 ${ids.length} 张专辑？` : `隐藏 ${ids.length} 张专辑？`,
      content: approved ? '所选专辑将重新对用户显示。' : '所选专辑将从专辑库隐藏，用户端不再可见（不会删除数据，可随时恢复）。',
      confirmText: approved ? '全部显示' : '全部隐藏',
      confirmColor: '#C94E25',
      success: (modal) => {
        if (!modal.confirm) return
        this.setData({ allBatchWorking: true })
        wx.showLoading({ title: '处理中…', mask: true })
        wx.cloud.callFunction({
          name: 'manageCandidates',
          data: { action: 'batch_toggle_approved', ids, approved },
          success: (res: any) => {
            wx.hideLoading()
            this.setData({ allBatchWorking: false })
            const r = res.result || {}
            if (!r.success) { wx.showToast({ title: r.error || '操作失败', icon: 'none' }); return }
            const idSet = new Set(ids)
            const patch = (a: Album) => idSet.has(a._id) ? { ...a, approved, selected: false } : a
            const allList = this.data.allList.map(patch)
            const multiList = this.data.multiList.map(patch)
            this.setData({ allList, multiList, allSelectedCount: 0, multiSelectedCount: 0 })
            wx.showToast({ title: `已处理 ${r.succeeded || 0} 张`, icon: 'success' })
          },
          fail: () => { wx.hideLoading(); this.setData({ allBatchWorking: false }); wx.showToast({ title: '网络错误', icon: 'none' }) },
        })
      },
    })
  },

  // ── 批量重新同步 tracks（不改归属，只是用已存的 artistIds 重新拉取/分类曲目）──
  onAllBatchResync() {
    if (this.data.resyncWorking) return
    const ids = this._selectedAlbums().map(a => a._id)
    if (!ids.length) { wx.showToast({ title: '请先选择专辑', icon: 'none' }); return }
    wx.showModal({
      title: `重新同步 ${ids.length} 张专辑的 Tracks？`,
      content: '会重新从网易云拉取曲目并按当前归属逻辑重新分类 Featuring Guests，不会改变已设置的归属歌手。数量较多时会比较慢。',
      confirmText: '开始同步',
      confirmColor: '#C94E25',
      success: (modal) => {
        if (!modal.confirm) return
        this.setData({ resyncWorking: true, resyncDone: 0, resyncTotal: ids.length, resyncFailed: 0 })
        this._runResyncStep(ids, 0)
      },
    })
  },

  _runResyncStep(ids: string[], idx: number) {
    if (idx >= ids.length) {
      this.setData({ resyncWorking: false }); this._clearBatchSelection()
      const failed = this.data.resyncFailed
      wx.showToast({ title: failed ? `完成，${failed} 张失败` : '同步完成', icon: failed ? 'none' : 'success' })
      return
    }
    wx.cloud.callFunction({
      name: 'syncAlbumTracks',
      data: { albumId: ids[idx] },
      success: (res: any) => {
        const r = res.result || {}
        this.setData({ resyncDone: idx + 1, resyncFailed: this.data.resyncFailed + (r.success ? 0 : 1) })
        this._runResyncStep(ids, idx + 1)
      },
      fail: () => {
        this.setData({ resyncDone: idx + 1, resyncFailed: this.data.resyncFailed + 1 })
        this._runResyncStep(ids, idx + 1)
      },
    } as any)
  },

  // ── 批量设置归属 ──────────────────────────────────────────────────────
  onAllBatchOwnership() {
    const ids = this._selectedAlbums().map(a => a._id)
    if (!ids.length) { wx.showToast({ title: '请先选择专辑', icon: 'none' }); return }
    this.setData({ ownerPickerVisible: true, ownerPickerAlbumCount: ids.length, ownerPickerKeyword: '', ownerPickerSelected: [] })
    this._searchOwnerPicker('')
  },

  _searchOwnerPicker(keyword: string) {
    wx.cloud.callFunction({
      name: 'getArtists',
      data: { keyword: String(keyword || '').trim(), limit: 30 },
      success: (res: any) => {
        const r = res.result || {}
        const selectedIds = new Set(this.data.ownerPickerSelected.map(a => a.artistId))
        const ownerPickerResults: OwnerPick[] = (r.success ? (r.list || []) : []).map((a: any) => ({
          artistId: String(a.artistId), artistName: a.artistName || '', picUrl: a.picUrl || '',
          selected: selectedIds.has(String(a.artistId)),
        }))
        this.setData({ ownerPickerResults })
      },
    } as any)
  },

  onOwnerPickerSearch(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value || ''
    this.setData({ ownerPickerKeyword: keyword })
    clearTimeout(_ownerSearchTimer)
    _ownerSearchTimer = setTimeout(() => this._searchOwnerPicker(keyword), 300)
  },

  onOwnerPickerPick(e: WechatMiniprogram.TouchEvent) {
    const artistId = String((e.currentTarget.dataset as any).id || '')
    if (!artistId) return
    const selected = this.data.ownerPickerSelected.slice()
    const idx = selected.findIndex(a => a.artistId === artistId)
    if (idx >= 0) {
      selected.splice(idx, 1)
    } else {
      const found = this.data.ownerPickerResults.find(a => a.artistId === artistId)
      if (found) selected.push({ ...found, selected: true })
    }
    const selectedIds = new Set(selected.map(a => a.artistId))
    const ownerPickerResults = this.data.ownerPickerResults.map(a => ({ ...a, selected: selectedIds.has(a.artistId) }))
    this.setData({ ownerPickerSelected: selected, ownerPickerResults })
  },

  onOwnerPickerRemove(e: WechatMiniprogram.TouchEvent) {
    const artistId = String((e.currentTarget.dataset as any).id || '')
    const ownerPickerSelected = this.data.ownerPickerSelected.filter(a => a.artistId !== artistId)
    const ownerPickerResults = this.data.ownerPickerResults.map(a => ({ ...a, selected: ownerPickerSelected.some(x => x.artistId === a.artistId) }))
    this.setData({ ownerPickerSelected, ownerPickerResults })
  },

  onOwnerPickerCancel() {
    if (this.data.ownerApplyWorking) return
    this.setData({ ownerPickerVisible: false, ownerPickerSelected: [], ownerPickerKeyword: '' })
  },

  onOwnerPickerConfirm() {
    if (this.data.ownerApplyWorking) return
    const targetArtists = this.data.ownerPickerSelected.map(a => ({ artistId: a.artistId, artistName: a.artistName }))
    if (!targetArtists.length) { wx.showToast({ title: '请至少选择一位归属歌手', icon: 'none' }); return }
    const ids = this._selectedAlbums().map(a => a._id)
    if (!ids.length) { wx.showToast({ title: '请先选择专辑', icon: 'none' }); return }
    const names = targetArtists.map(a => a.artistName).join(' / ')
    wx.showModal({
      title: `设置 ${ids.length} 张专辑的归属？`,
      content: `将把这些专辑的归属统一设为：${names}\n原有 tracks 中的其他歌手会自动归为 Featuring Guests。`,
      confirmText: '确认设置',
      confirmColor: '#C94E25',
      success: (modal) => {
        if (!modal.confirm) return
        this.setData({ ownerApplyWorking: true })
        wx.showLoading({ title: '处理中…', mask: true })
        wx.cloud.callFunction({
          name: 'manageAlbumOwnershipCorrections',
          data: { action: 'batchApply', albumIds: ids, targetArtists },
          success: (res: any) => {
            wx.hideLoading()
            this.setData({ ownerApplyWorking: false })
            const r = res.result || {}
            if (!r.success) { wx.showToast({ title: r.error || '操作失败', icon: 'none' }); return }
            const idSet = new Set(ids)
            const patch = (a: Album) => idSet.has(a._id) ? { ...a, artist: names, primaryArtist: targetArtists[0].artistName, selected: false } : a
            const allList = this.data.allList.map(patch)
            const titleResults = this.data.titleResults.map(patch)
            const multiList = this.data.multiList.map(patch)
            this.setData({
              allList, titleResults, multiList, allSelectedCount: 0, multiSelectedCount: 0,
              ownerPickerVisible: false, ownerPickerSelected: [], ownerPickerKeyword: '',
            })
            const failedCount = (r.failed || []).length
            wx.showToast({ title: failedCount ? `已设置 ${r.succeeded || 0} 张，${failedCount} 张失败` : `已设置 ${r.succeeded || 0} 张`, icon: failedCount ? 'none' : 'success' })
          },
          fail: () => { wx.hideLoading(); this.setData({ ownerApplyWorking: false }); wx.showToast({ title: '网络错误', icon: 'none' }) },
        } as any)
      },
    })
  },

  noop() {},

  onBackfillLetters() {
    if (this.data.backfilling) return
    this.setData({ backfilling: true, backfillDone: 0 })
    this._runBackfillStep(0)
  },

  _runBackfillStep(skip: number) {
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'backfill_album_letters', skip },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success) { this.setData({ backfilling: false }); wx.showToast({ title: r.error || '索引失败', icon: 'none' }); return }
        this.setData({ backfillDone: r.processed || 0 })
        if (r.done) {
          this.setData({ backfilling: false })
          wx.showToast({ title: '索引完成', icon: 'success' })
          this._loadLetterCounts()
          return
        }
        this._runBackfillStep(r.nextSkip)
      },
      fail: () => { this.setData({ backfilling: false }); wx.showToast({ title: '网络错误', icon: 'none' }) },
    })
  },

  onTitleSearch(e: WechatMiniprogram.Input) {
    const keyword = e.detail.value || ''
    this.setData({ titleKeyword: keyword })
    clearTimeout(_titleSearchTimer)
    _titleSearchTimer = setTimeout(() => this._searchByTitle(keyword), 400)
  },

  _searchByTitle(keyword: string) {
    const kw = keyword.trim()
    if (!kw) { this.setData({ titleResults: [], titleLoading: false }); return }
    this.setData({ titleLoading: true })
    wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'search_admin_albums', keyword: kw },
      success: (res: any) => {
        const r = res.result || {}
        this.setData({ titleResults: r.success ? (r.list || []) : [], titleLoading: false })
      },
      fail: () => this.setData({ titleLoading: false }),
    })
  },

  onReachBottom() {
    return
  },

  onPullDownRefresh() {
    if (this.data.view === 'artists') {
      this._loadArtists(1)
      this.setData({ cleanupPreview: null, cleanupResult: null })
    } else if (this.data.selectedArtist) {
      this._loadAlbums(this.data.selectedArtist)
    }
    wx.stopPullDownRefresh()
  },

  onArtistTap(e: WechatMiniprogram.TouchEvent) {
    const artist = (e.currentTarget.dataset as { artist: Artist }).artist
    this.setData({ view: 'albums', selectedArtist: artist, albumList: [] })
    this._loadAlbums(artist)
  },

  onPreviewDuplicates() {
    if (this.data.cleanupLoading) return
    this.setData({ cleanupLoading: true, cleanupResult: null })
    wx.cloud.callFunction({
      name: 'cleanupDuplicates',
      data: { dryRun: true },
      success: (res: any) => {
        const r = res.result || {}
        this.setData({ cleanupLoading: false })
        if (!r.success) { wx.showToast({ title: '扫描失败', icon: 'error' }); return }
        this.setData({ cleanupPreview: {
          scanned: r.scanned || 0,
          duplicateGroups: r.duplicateGroups || 0,
          wouldRemove: r.wouldRemove || 0,
          samples: r.samples || [],
        } })
        wx.showToast({ title: r.wouldRemove ? '发现重复' : '暂无重复', icon: 'none' })
      },
      fail: () => { this.setData({ cleanupLoading: false }); wx.showToast({ title: '网络错误', icon: 'error' }) },
    })
  },

  onRunDuplicateCleanup() {
    const preview = this.data.cleanupPreview
    if (!preview || !preview.wouldRemove || this.data.cleanupLoading) return
    wx.showModal({
      title: '确认清理重复专辑？',
      content: `将删除 ${preview.wouldRemove} 张重复专辑，并把评论/收藏迁移到保留专辑。该操作不可撤销。`,
      confirmText: '确认清理',
      confirmColor: '#dc2626',
      success: (modalRes) => {
        if (!modalRes.confirm) return
        this.setData({ cleanupLoading: true })
        wx.cloud.callFunction({
          name: 'cleanupDuplicates',
          data: { dryRun: false },
          success: (res: any) => {
            const r = res.result || {}
            this.setData({ cleanupLoading: false })
            if (!r.success) { wx.showToast({ title: '清理失败', icon: 'error' }); return }
            this.setData({ cleanupResult: r, cleanupPreview: null })
            wx.showToast({ title: `已删除 ${r.removed || 0} 张`, icon: 'success' })
            this._loadArtists(1)
          },
          fail: () => { this.setData({ cleanupLoading: false }); wx.showToast({ title: '网络错误', icon: 'error' }) },
        })
      },
    })
  },

  _loadAlbums(artist: Artist) {
    this.setData({ albumLoading: true })

    const discographyCall = wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'list_admin_albums', artistId: artist.artistId, artistName: artist.artistName },
    }).catch(() => ({ result: { success: false, list: [] } }))

    const databaseCall = wx.cloud.callFunction({
      name: 'manageCandidates',
      data: { action: 'search_admin_albums', keyword: artist.artistName },
    }).catch(() => ({ result: { success: false, list: [] } }))

    Promise.all([discographyCall, databaseCall]).then((responses: any[]) => {
      const discographyResult = responses[0]?.result || {}
      const databaseResult = responses[1]?.result || {}

      if (!discographyResult.success && !databaseResult.success) {
        this.setData({ albumLoading: false })
        return
      }

      const merged = [
        ...(discographyResult.success ? (discographyResult.list || []) : []),
        ...(databaseResult.success ? (databaseResult.list || []) : []),
      ] as Album[]

      const seen = new Set<string>()
      const list = merged
        .filter((album) => {
          if (!album || !album._id || seen.has(album._id)) return false
          seen.add(album._id)
          return true
        })
        .sort((a, b) => (b.releaseYear || 0) - (a.releaseYear || 0))

      this.setData({ albumList: list, albumLoading: false })
    })
  },

  onToggleApproved(e: WechatMiniprogram.TouchEvent) {
    const { id, approved } = e.currentTarget.dataset as { id: string; approved: boolean }
    if (this.data.toggling[id]) return
    const newApproved = !approved
    this.setData({ toggling: { ...this.data.toggling, [id]: true } })

    wx.cloud.callFunction({
      name: 'manageAlbumCandidates',
      data: { action: 'setHiddenState', albumId: id, approved: newApproved },
      success: (res: any) => {
        const toggling = { ...this.data.toggling }
        delete toggling[id]
        if (res.result?.success) {
          const patch = (a: Album) => a._id === id ? { ...a, approved: newApproved } : a
          const albumList = this.data.albumList.map(patch)
          const titleResults = this.data.titleResults.map(patch)
          const allList = this.data.allList.map(patch)
          const multiList = this.data.multiList.map(patch)
          this.setData({ albumList, titleResults, allList, multiList, toggling })
          wx.showToast({ title: newApproved ? '已显示' : '已隐藏', icon: 'success' })
          this._loadArtists(1)
        } else {
          this.setData({ toggling })
          wx.showToast({ title: res.result?.error || '操作失败', icon: 'none' })
        }
      },
      fail: () => {
        const toggling = { ...this.data.toggling }
        delete toggling[id]
        this.setData({ toggling })
        wx.showToast({ title: '网络错误', icon: 'error' })
      },
    })
  },

  onUnload() { clearTimeout(_searchTimer); clearTimeout(_titleSearchTimer); clearTimeout(_ownerSearchTimer) },
})
