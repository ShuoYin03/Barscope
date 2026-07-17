import { getThemeClass } from '../../utils/theme'

type TemplateKey = 'review' | 'feature' | 'interview'
type BlockType = 'paragraph' | 'heading' | 'image' | 'quote' | 'pullquote' | 'divider' | 'qa'

interface EditorialBlock {
  id: string
  type: BlockType
  content?: string
  label?: string
  question?: string
  answer?: string
  imageUrl?: string
  layout?: 'inline' | 'wide' | 'full' | 'portrait'
}

const BLOCK_OPTIONS: Array<{ type: BlockType; label: string; zh: string }> = [
  { type: 'paragraph', label: 'PARAGRAPH', zh: '正文段落' },
  { type: 'heading', label: 'HEADING', zh: '章节标题' },
  { type: 'image', label: 'IMAGE', zh: '图片' },
  { type: 'quote', label: 'QUOTE', zh: '引用' },
  { type: 'pullquote', label: 'PULL QUOTE', zh: '大字观点' },
  { type: 'divider', label: 'DIVIDER', zh: '章节分隔' },
  { type: 'qa', label: 'Q&A', zh: '访谈问答' },
]

function newBlock(type: BlockType): EditorialBlock {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  if (type === 'image') return { id, type, imageUrl: '', layout: 'wide', label: '' }
  if (type === 'qa') return { id, type, question: '', answer: '' }
  if (type === 'divider') return { id, type, label: 'SIDE A', content: '' }
  return { id, type, content: '' }
}

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    template: 'review' as TemplateKey,
    proposalId: '',
    title: '',
    deck: '',
    author: '',
    score: '',
    blocks: [] as EditorialBlock[],
    blockOptions: BLOCK_OPTIONS,
    blockPickerVisible: false,
    previewMode: false,
    saving: false,
    submitted: false,
    accessReady: false,
  },

  onLoad(options: Record<string, string>) {
    const app = getApp<IAppOption>()
    const template = ['review', 'feature', 'interview'].includes(options.template) ? options.template as TemplateKey : 'review'
    const proposalId = String(options.proposalId || '')
    const key = proposalId ? `editorial-draft-${proposalId}` : `editorial-draft-${template}`
    const saved = wx.getStorageSync(key) || {}
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
      template,
      proposalId,
      title: saved.title || String(options.title || ''),
      deck: saved.deck || '',
      author: saved.author || (app.globalData.userInfo?.nickName || ''),
      score: saved.score || '',
      blocks: saved.blocks || [newBlock(template === 'interview' ? 'qa' : 'paragraph')],
      submitted: !!saved.submitted,
    })

    if (app.globalData.isAdmin) {
      this.setData({ accessReady: true })
      return
    }
    if (!proposalId) {
      wx.showModal({ title: '暂无编辑权限', content: '专题编辑器仅对审核通过的 Proposal 作者开放。', showCancel: false, complete: () => wx.navigateBack() })
      return
    }
    wx.cloud.callFunction({
      name: 'editorialAccess',
      data: { action: 'verify', proposalId },
      success: (res: any) => {
        const r = res.result || {}
        if (!r.success || !r.allowed) {
          wx.showModal({ title: '暂无编辑权限', content: r.error || '该 Proposal 尚未通过审核。', showCancel: false, complete: () => wx.navigateBack() })
          return
        }
        this.setData({ accessReady: true, title: this.data.title || r.proposal?.proposalTitle || '' })
      },
      fail: () => wx.showModal({ title: '权限校验失败', content: '请稍后重试。', showCancel: false, complete: () => wx.navigateBack() }),
    } as any)
  },

  onShow() { this.setData({ themeClass: getThemeClass() }) },
  onBack() { wx.navigateBack() },

  onFieldInput(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const field = String((e.currentTarget.dataset as any).field || '')
    if (!field) return
    this.setData({ [field]: e.detail.value } as any)
  },

  onTemplateTap(e: WechatMiniprogram.TouchEvent) {
    const template = String((e.currentTarget.dataset as any).template || '') as TemplateKey
    if (!['review', 'feature', 'interview'].includes(template)) return
    this.setData({ template })
  },

  onTogglePreview() { this.setData({ previewMode: !this.data.previewMode, blockPickerVisible: false }) },
  onAddBlock() { this.setData({ blockPickerVisible: true }) },
  onCloseBlockPicker() { this.setData({ blockPickerVisible: false }) },
  noop() {},
  onPickBlock(e: WechatMiniprogram.TouchEvent) {
    const type = String((e.currentTarget.dataset as any).type || '') as BlockType
    if (!BLOCK_OPTIONS.some(x => x.type === type)) return
    this.setData({ blocks: [...this.data.blocks, newBlock(type)], blockPickerVisible: false })
  },

  onBlockInput(e: WechatMiniprogram.Input | WechatMiniprogram.TextareaInput) {
    const index = Number((e.currentTarget.dataset as any).index)
    const field = String((e.currentTarget.dataset as any).field || 'content')
    const blocks = [...this.data.blocks]
    if (!blocks[index]) return
    blocks[index] = { ...blocks[index], [field]: e.detail.value }
    this.setData({ blocks })
  },

  onChooseImage(e: WechatMiniprogram.TouchEvent) {
    const index = Number((e.currentTarget.dataset as any).index)
    wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], success: (res) => {
      const path = res.tempFiles?.[0]?.tempFilePath
      if (!path) return
      const blocks = [...this.data.blocks]
      blocks[index] = { ...blocks[index], imageUrl: path }
      this.setData({ blocks })
    } })
  },

  onImageLayout(e: WechatMiniprogram.TouchEvent) {
    const index = Number((e.currentTarget.dataset as any).index)
    const layouts = [
      { label: 'INLINE · 正文宽度', value: 'inline' }, { label: 'WIDE · 宽幅', value: 'wide' },
      { label: 'FULL BLEED · 满版', value: 'full' }, { label: 'PORTRAIT · 竖图', value: 'portrait' },
    ]
    wx.showActionSheet({ itemList: layouts.map(x => x.label), success: (res) => {
      const picked = layouts[res.tapIndex]
      if (!picked) return
      const blocks = [...this.data.blocks]
      blocks[index] = { ...blocks[index], layout: picked.value as any }
      this.setData({ blocks })
    } })
  },

  onMoveBlock(e: WechatMiniprogram.TouchEvent) {
    const index = Number((e.currentTarget.dataset as any).index)
    const direction = String((e.currentTarget.dataset as any).direction || '')
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= this.data.blocks.length) return
    const blocks = [...this.data.blocks]
    ;[blocks[index], blocks[target]] = [blocks[target], blocks[index]]
    this.setData({ blocks })
  },

  onDeleteBlock(e: WechatMiniprogram.TouchEvent) {
    const index = Number((e.currentTarget.dataset as any).index)
    this.setData({ blocks: this.data.blocks.filter((_: EditorialBlock, i: number) => i !== index) })
  },

  onSave() {
    this.setData({ saving: true })
    const key = this.data.proposalId ? `editorial-draft-${this.data.proposalId}` : `editorial-draft-${this.data.template}`
    wx.setStorageSync(key, { title: this.data.title, deck: this.data.deck, author: this.data.author, score: this.data.score, blocks: this.data.blocks, submitted: this.data.submitted, updatedAt: Date.now() })
    this.setData({ saving: false })
    wx.showToast({ title: '草稿已保存', icon: 'success' })
  },

  onSubmit() {
    if (!this.data.title.trim()) { wx.showToast({ title: '请先填写标题', icon: 'none' }); return }
    wx.showModal({ title: '提交终审？', content: '提交后编辑部将根据排版和内容进行终审。当前版本会保存在本机草稿中。', confirmText: '提交', success: (res) => {
      if (!res.confirm) return
      this.setData({ submitted: true })
      this.onSave()
    } })
  },
})