import Link from 'next/link'
import { SiteHeader } from '@/components/site-header'

const releases = [
  { title: '新发行占位', artist: 'ARTIST', meta: '2026 · LP' },
  { title: '下一张专辑', artist: 'ARTIST', meta: '2026 · MIXTAPE' },
  { title: '新声音', artist: 'ARTIST', meta: '2026 · EP' },
]

const reviews = [
  { user: '金鱼', album: '王国之泪', score: '9.0', body: '鲍比最好的一张，短小精悍，每首都很喜欢。' },
  { user: 'selfish', album: '答应我会幸福', score: '9.0', body: '那些冰冷的、没有被认可和理解的噪郁，都可以成为对抗世界的勇气。' },
  { user: 'BARSCOPE', album: '本周编辑选择', score: '8.6', body: '这里会接入真实社区评论、点赞与回复数据。' },
]

export default function HomePage() {
  return (
    <main>
      <SiteHeader />

      <section className="hero shell">
        <div className="eyebrow">NOW · 今日热议</div>
        <div className="hero-grid">
          <div>
            <p className="hero-kicker">SIDE A / EDITORIAL</p>
            <h1>中文说唱的<br />另一面。</h1>
            <p className="hero-copy">专辑、乐评、人物与场景。Barscope 网页版将小程序的社区数据与更完整的 Editorial 阅读体验放在同一张唱片上。</p>
            <div className="hero-actions">
              <Link className="button primary" href="/features">READ FEATURES</Link>
              <Link className="button ghost" href="/reviews">LATEST REVIEWS</Link>
            </div>
          </div>
          <aside className="hero-panel">
            <span className="panel-label">TRENDING NOW</span>
            <strong>今日讨论最多的专辑</strong>
            <div className="score-line"><span>COMMUNITY SCORE</span><b>8.8</b></div>
            <div className="score-line"><span>RECENT REVIEWS</span><b>24</b></div>
          </aside>
        </div>
      </section>

      <section className="ticker"><span>NEW RELEASES</span><span>REVIEWS</span><span>INTERVIEWS</span><span>FEATURES</span><span>COMMUNITY</span></section>

      <section className="shell section-block two-column">
        <div>
          <div className="section-heading"><span>SIDE B</span><h2>RECENT RELEASES</h2><Link href="/albums">VIEW ALL →</Link></div>
          <div className="release-grid">
            {releases.map((item, index) => (
              <article className="release-card" key={item.title}>
                <div className="cover-placeholder"><span>0{index + 1}</span></div>
                <p className="card-meta">{item.meta}</p>
                <h3>{item.title}</h3>
                <p>{item.artist}</p>
              </article>
            ))}
          </div>
        </div>

        <aside className="editorial-rail">
          <div className="section-heading compact"><span>SIDE C</span><h2>FEATURED STORY</h2></div>
          <article className="feature-card">
            <p className="card-meta">LONGFORM / 12 MIN</p>
            <h3>真正有力量的作品，不是把答案告诉你，而是让你重新听见问题。</h3>
            <p>这里会承载 Review、Feature 与 Interview 三套 Editorial 模板。</p>
            <Link href="/features">OPEN STORY →</Link>
          </article>
        </aside>
      </section>

      <section className="reviews-section">
        <div className="shell">
          <div className="section-heading"><span>SIDE D</span><h2>LATEST REVIEWS</h2><Link href="/reviews">ALL REVIEWS →</Link></div>
          <div className="review-list">
            {reviews.map((review) => (
              <article className="review-row" key={`${review.user}-${review.album}`}>
                <div className="review-user"><div className="avatar-placeholder">{review.user.slice(0, 1)}</div><div><strong>{review.user}</strong><span>JUST NOW</span></div></div>
                <div className="review-body"><span className="album-tag">{review.album}</span><p>{review.body}</p><small>♡ 0 &nbsp;&nbsp; ↩ 0 条回复</small></div>
                <div className="review-score">{review.score}</div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <footer className="site-footer shell">
        <div><strong>BARSCOPE</strong><span>韵镜 · CHINESE RAP EDITORIAL & COMMUNITY</span></div>
        <p>WEB FOUNDATION · PHASE 01</p>
      </footer>
    </main>
  )
}
