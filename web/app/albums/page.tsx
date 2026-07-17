import { SiteHeader } from '@/components/site-header'
import { AlbumGrid } from '@/components/album-grid'

export default function AlbumsPage() {
  return (
    <main>
      <SiteHeader />
      <section className="shell">
        <div className="page-header">
          <span className="eyebrow">SIDE A · DATABASE</span>
          <h1>ALBUMS</h1>
          <p>中文说唱专辑库，按年份浏览，评分最高的排在最前面。</p>
        </div>
        <AlbumGrid />
      </section>
    </main>
  )
}
