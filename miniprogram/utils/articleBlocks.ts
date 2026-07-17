// Shared block schema for editorial content (人物访谈 / 深度乐评 and any future long-form
// article type). Authors compose an article as an ordered array of these typed blocks instead of
// a single text field, so the block-editor page and the <article-blocks> renderer component both
// target the same shape. Every block renders with fixed, on-brand styling — the editor lets people
// arrange structure and swap content, not touch fonts/colors/spacing, so every article still reads
// as part of the same app.
export type ArticleBlock =
  | { type: 'heading'; kicker?: string; text: string }
  | { type: 'paragraph'; text: string; lead?: boolean }
  | { type: 'image'; url: string; caption?: string }
  | { type: 'quote'; text: string; size?: 'normal' | 'large' }
  | { type: 'stat'; items: { num: string; label: string }[] }
  | { type: 'album'; albumId: string; title: string; artist: string; coverUrl: string; score?: number }
  | { type: 'artist'; artistId: string; artistName: string; avatarUrl: string }
  | { type: 'divider' }

export const BLOCK_TYPE_LABELS: Record<ArticleBlock['type'], string> = {
  heading: '分节标题',
  paragraph: '正文段落',
  image: '图片',
  quote: '引用',
  stat: '数据条',
  album: '专辑卡片',
  artist: '艺人卡片',
  divider: '分隔线',
}
