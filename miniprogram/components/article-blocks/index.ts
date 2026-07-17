import type { ArticleBlock } from '../../utils/articleBlocks'

// WXML can't slice strings, so a "lead" paragraph's drop-cap first character is split out here
// before render rather than in the template.
function toRenderBlock(b: ArticleBlock, i: number): any {
  if (b.type === 'paragraph' && b.lead) {
    const text = String(b.text || '')
    return { ...b, key: i, dropcapChar: text.slice(0, 1), rest: text.slice(1) }
  }
  return { ...b, key: i }
}

Component({
  properties: {
    blocks: { type: Array, value: [] as ArticleBlock[] },
  },
  data: {
    renderBlocks: [] as any[],
  },
  observers: {
    blocks(blocks: ArticleBlock[]) {
      this.setData({ renderBlocks: (blocks || []).map(toRenderBlock) })
    },
  },
  methods: {
    onAlbumTap(e: WechatMiniprogram.TouchEvent) {
      const id = String((e.currentTarget.dataset as any).id || '')
      if (id) wx.navigateTo({ url: `/pages/album-detail/index?id=${id}` })
    },
    onArtistTap(e: WechatMiniprogram.TouchEvent) {
      const ds = e.currentTarget.dataset as any
      if (ds.artistId) wx.navigateTo({ url: `/pages/artist/index?artistId=${ds.artistId}&artistName=${encodeURIComponent(ds.artistName || '')}` })
    },
  },
})
