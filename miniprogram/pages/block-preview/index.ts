import { getThemeClass } from '../../utils/theme'
import { ArticleBlock, BLOCK_TYPE_LABELS } from '../../utils/articleBlocks'

const SAMPLE_BLOCKS: ArticleBlock[] = [
  { type: 'paragraph', lead: true, text: '当一张专辑真正成立的时候，它不会只留下几首好歌。它会建立一套自己的时间、空间与语言，让听者在几十分钟里进入一个完整世界——这是一段带首字放大（drop cap）的开篇段落，用来标记文章正文的起点。' },
  { type: 'paragraph', text: '这是一段普通正文段落。区块系统里大部分内容都会是这种类型：纯文字，行距、字号、颜色全部固定，作者只需要填文字进去。' },
  { type: 'quote', size: 'normal', text: '真正有力量的作品，不是把答案告诉你，而是让你重新听见问题。' },
  { type: 'heading', kicker: 'SIDE B', text: 'THE SHIFT' },
  { type: 'paragraph', text: '分节标题（heading）用来把一篇长文切成有节奏的几段，常见于深度专题和长访谈。上面这条就是一个 heading 区块，kicker 是小标签，text 是大标题。' },
  { type: 'image', url: '', caption: '图片区块：上传封面/现场照/内页图，下方可以加一行小字说明。此处没有真实图片，留空展示占位效果。' },
  { type: 'stat', items: [{ num: '47', label: 'RELATED RELEASES' }, { num: '19', label: 'ARTISTS' }, { num: '5', label: 'YEARS' }] },
  { type: 'quote', size: 'large', text: 'RAGE 从来不只是一个 Beat，它是一整套关于速度、失真与身份的想象。' },
  { type: 'divider' },
  { type: 'paragraph', text: '分隔线（divider）用来在不需要标题的地方做一次视觉停顿，比如章节之间、引用前后。' },
  { type: 'album', albumId: '', title: '示例专辑标题', artist: '示例歌手', coverUrl: '', score: 8.4 },
  { type: 'artist', artistId: '', artistName: '示例艺人', avatarUrl: '' },
  { type: 'paragraph', text: '专辑卡片和艺人卡片可以直接嵌入到文章正文里，点击会跳转到对应的专辑详情页 / 艺人主页，把文章和数据库里的真实内容连起来。' },
]

Page({
  data: {
    statusBarHeight: 20,
    topbarHeight: 64,
    themeClass: '',
    blocks: SAMPLE_BLOCKS,
    legend: Object.keys(BLOCK_TYPE_LABELS).map(key => ({ key, label: (BLOCK_TYPE_LABELS as any)[key] })),
  },
  onLoad() {
    const app = getApp<IAppOption>()
    this.setData({ statusBarHeight: app.globalData.statusBarHeight, topbarHeight: app.globalData.topbarHeight })
  },
  onShow() { this.setData({ themeClass: getThemeClass() }) },
  onBack() { wx.navigateBack() },
})
