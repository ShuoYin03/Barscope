import Link from 'next/link'
import { SiteHeader } from '@/components/site-header'
import { RecentReleases } from '@/components/recent-releases'
import { LatestReviews } from '@/components/latest-reviews'

export default function HomePage() {
  return (
    <main>
      <SiteHeader />

      <section className="home-hero shell">
        <div className="hero-art" aria-label="Featured editorial visual">
          <div className="hero-art-noise" />
          <span className="hero-art-index">001</span>
          <div className="hero-art-copy">
            <span>NOW PLAYING</span>
            <strong>SOUNDIVE<br />EDITORIAL</strong>
          </div>
        </div>

        <div className="hero-story">
          <div className="eyebrow-row"><span>FEATURED STORY</span><span>07 / 17 / 2026</span></div>
          <p className="hero-kicker">SIDE A · 今日热议</p>
          <h1>中文说唱，<br />不止一种听法。</h1>
          <p className="hero-deck">从专辑、人物到场景，让社区里的声音和真正值得被留下的故事出现在同一页。</p>
          <div className="hero-meta-line"><span>COMMUNITY SCORE <b>8.8</b></span><span>24 NEW REVIEWS</span></div>
          <Link className="text-link hero-link" href="/features">READ THE STORY <span>↗</span></Link>
        </div>
      </section>

      <section className="marquee-strip" aria-label="Soundive sections">
        <div className="marquee-track">
          <span>NEW RELEASES</span><i>✦</i><span>REVIEWS</span><i>✦</i><span>INTERVIEWS</span><i>✦</i><span>FEATURES</span><i>✦</i><span>COMMUNITY</span><i>✦</i><span>NEW RELEASES</span><i>✦</i><span>REVIEWS</span>
        </div>
      </section>

      <section className="shell releases-section">
        <div className="section-title-row">
          <div><span className="section-index">SIDE B</span><h2>RECENT RELEASES</h2></div>
          <Link className="text-link" href="/albums">VIEW ALL <span>↗</span></Link>
        </div>
        <RecentReleases />
      </section>

      <section className="shell editorial-grid">
        <article className="lead-story">
          <div className="lead-story-art"><span>INTERVIEW 004</span></div>
          <div className="lead-story-copy">
            <span className="section-index">SIDE C · INTERVIEW</span>
            <h2>“我不想解释我是谁，<br />我只想把声音留下来。”</h2>
            <p>人物、场景与正在发生的中文说唱文化。长篇访谈会成为 Soundive 网页版最重要的内容入口之一。</p>
            <Link className="text-link" href="/features">ENTER CONVERSATION <span>↗</span></Link>
          </div>
        </article>

        <aside className="editorial-stack">
          <article className="stack-story">
            <span className="section-index">FEATURE / 08 MIN</span>
            <h3>从地下到屏幕：一个场景如何被重新观看</h3>
            <p>Longform, visual essays and scene reports.</p>
          </article>
          <article className="stack-story accent-story">
            <span className="section-index">EDITOR'S NOTE</span>
            <h3>真正有力量的作品，不是把答案告诉你。</h3>
            <Link className="text-link dark-link" href="/features">READ MORE <span>↗</span></Link>
          </article>
        </aside>
      </section>

      <section className="reviews-section">
        <div className="shell">
          <div className="section-title-row review-title-row">
            <div><span className="section-index">SIDE D</span><h2>LATEST REVIEWS</h2></div>
            <Link className="text-link" href="/reviews">ALL REVIEWS <span>↗</span></Link>
          </div>
          <LatestReviews />
        </div>
      </section>

      <footer className="site-footer shell">
        <div><strong>SOUNDIVE</strong><span>韵镜 · CHINESE RAP EDITORIAL & COMMUNITY</span></div>
        <p>LISTEN DEEPER. LOOK CLOSER.</p>
      </footer>
    </main>
  )
}
