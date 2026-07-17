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

const BLOCK_LABELS: Record<BlockType, string> = {
  paragraph: 'PARAGRAPH · 正文',
  heading: 'HEADING · 标题',
  image: 'IMAGE · 图片',
  quote: 'QUOTE · 引用',
  pullquote: 'PULL QUOTE · 大字观点',
  divider: 'DIVIDER · 章节',
  qa: 'Q&A · 访谈问答',
}

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
    title: '',
    deck: '',
    author: '',
    score: '',
    blocks: [] as EditorialBlock[],
    previewMode: false,
    saving: false,
    submitted: false,
  },

  onLoad(options: Record<string, string>) {
    const app = getApp<IAppOption>()
    const template = ['review', 'feature', 'interview'].includes(options.template) ? options.template as TemplateKey : 'review'
    const key = `editorial-draft-${template}`
    const saved = wx.getStorageSync(key) || {}
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      topbarHeight: app.globalData.topbarHeight,
      template,
      title: saved.title || '',
      deck: saved.deck || '',
      author: saved.author || (app.globalData.userInfo?.nickName || ''),
      score: saved.score || '',
      blocks: saved.blocks || [newBlock(template === 'interview' ? 'qa' : 'paragraph')],
      submitted: !!saved.submitted,
    })
  },

  onShow() { this.setData({ themeClass: getThemeClass() }) },
  onBack() { wx.navigateBack() },

  onFieldInput(e: WechatMiniprogram.Input) {
    const field = String((e.currentTarget.dataset as any).field || '')
    if (!field) return
    this.setData({ [field]: e.detail.value } as any)
  },

  onTemplateTap(e: WechatMiniprogram.TouchEvent) {
    const template = String((e.currentTarget.dataset as any).template || '') as TemplateKey
    if (!['review', 'feature', 'interview'].includes(template)) return
    this.setData({ template })
  },

  onTogglePreview() { this.setData({ previewMode: !this.data.previewMode }) },

  onAddBlock() {
    const options: Array<{ type: BlockType; label: string }> = [
      { type: 'paragraph', label: BLOCK_LABELS.paragraph },
      { type: 'heading', label: BLOCK_LABELS.heading },
      { type: 'image', label: BLOCK_LABELS.image },
      { type: 'quote', label: BLOCK_LABELS.quote },
      { type: 'pullquote', label: BLOCK_LABELS.pullquote },
      { type: 'divider', label: BLOCK_LABELS.divider },
      { type: 'qa', label: BLOCK_LABELS.qa },
    ]
    wx.showActionSheet({
      itemList: options.map(x => x.label),
      success: (res) => {
        const picked = options[res.tapIndex]
        if (!picked) return
        this.setData({ blocks: [...this.data.blocks, newBlock(picked.type)] })
      },
    })
  },

  onBlockInput(e: WechatMiniprogram.Input) {
    const index = Number((e.currentTarget.dataset as any).index)
    const field = String((e.currentTarget.dataset as any).field || 'content')
    const blocks = [...this.data.blocks]
    if (!blocks[index]) return
    blocks[index] = { ...blocks[index], [field]: e.detail.value }
    this.setData({ blocks })
  },

  onChooseImage(e: WechatMiniprogram.TouchEvent) {
    const index = Number((e.currentTarget.dataset as any).index)
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const path = res.tempFiles?.[0]?.tempFilePath
        if (!path) return
        const blocks = [...this.data.blocks]
        blocks[index] = { ...blocks[index], imageUrl: path }
        this.setData({ blocks })
      },
    })
  },

  onImageLayout(e: WechatMiniprogram.TouchEvent) {
    const index = Number((e.currentTarget.dataset as any).index)
    const layouts = [
      { label: 'INLINE · 正文宽度', value: 'inline' },
      { label: 'WIDE · 宽幅', value: 'wide' },
      { label: 'FULL BLEED · 满版', value: 'full' },
      { label: 'PORTRAIT · 竖图', value: 'portrait' },
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
    const blocks = this.data.blocks.filter((_: EditorialBlock, i: number) => i !== index)
    this.setData({ blocks })
  },

  onSave() {
    this.setData({ saving: true })
    const key = `editorial-draft-${this.data.template}`
    wx.setStorageSync(key, {
      title: this.data.title,
      deck: this.data.deck,
      author: this.data.author,
      score: this.data.score,
      blocks: this.data.blocks,
      submitted: this.data.submitted,
      updatedAt: Date.now(),
    })
    this.setData({ saving: false })
    wx.showToast({ title: '草稿已保存', icon: 'success' })
  },

  onSubmit() {
    if (!this.data.title.trim()) { wx.showToast({ title: '请先填写标题', icon: 'none' }); return }
    wx.showModal({
      title: '提交终审？',
      content: '提交后编辑部将根据排版和内容进行终审。当前版本会保存在本机草稿中。',
      confirmText: '提交',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ submitted: true })
        this.onSave()
      },
    })
  },
})
