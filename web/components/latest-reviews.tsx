'use client'

import { useEffect, useState } from 'react'
import { callFunction } from '@/lib/cloudbase'

interface ReviewRow {
  _id: string
  albumId: string
  albumTitle: string
  userName: string
  score: string
  content: string
  timeAgo: string
  likes: number
  replyCount: number
}

export function LatestReviews() {
  const [reviews, setReviews] = useState<ReviewRow[] | null>(null)

  useEffect(() => {
    let cancelled = false
    callFunction<{ success: boolean; list?: ReviewRow[] }>('getReviews', { recent: true, pageSize: 4 })
      .then((r) => { if (!cancelled) setReviews(r.success ? (r.list || []) : []) })
      .catch(() => { if (!cancelled) setReviews([]) })
    return () => { cancelled = true }
  }, [])

  if (reviews === null) {
    return <p className="hero-copy">加载中…</p>
  }

  if (reviews.length === 0) {
    return <p className="hero-copy">暂无最新评论。</p>
  }

  const [lead, ...feed] = reviews

  return (
    <div className="review-editorial-grid">
      <article className="review-lead">
        <span className="review-kicker">COMMUNITY PICK</span>
        <div className="review-lead-score">{lead.score}</div>
        <h3>{lead.albumTitle}</h3>
        <p>&ldquo;{lead.content}&rdquo;</p>
        <div className="review-byline">BY {lead.userName} · {lead.timeAgo}</div>
      </article>
      <div className="review-feed">
        {feed.map((review, index) => (
          <article className="review-feed-row" key={review._id}>
            <span className="feed-index">0{index + 2}</span>
            <div>
              <div className="feed-top"><strong>{review.albumTitle}</strong><b>{review.score}</b></div>
              <p>{review.content}</p>
              <small>BY {review.userName} · ♡ {review.likes} · ↩ {review.replyCount}</small>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
