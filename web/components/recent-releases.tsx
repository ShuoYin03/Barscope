'use client'

import { useEffect, useState } from 'react'
import { callFunction } from '@/lib/cloudbase'

interface ReleaseAlbum {
  albumId: string
  title: string
  artist: string
  releaseYear: number
  coverUrl: string
  avgScore: number
}

const TONES = ['burnt', 'violet', 'steel', 'olive']

export function RecentReleases() {
  const [releases, setReleases] = useState<ReleaseAlbum[] | null>(null)

  useEffect(() => {
    let cancelled = false
    callFunction<{ success: boolean; list?: ReleaseAlbum[] }>('getLatestAlbums', { limit: 4 })
      .then((r) => { if (!cancelled) setReleases(r.success ? (r.list || []) : []) })
      .catch(() => { if (!cancelled) setReleases([]) })
    return () => { cancelled = true }
  }, [])

  if (releases === null) {
    return (
      <div className="release-wall">
        {[0, 1, 2, 3].map((i) => (
          <article className="release-item" key={i}>
            <div className={`release-art ${TONES[i % TONES.length]}`}>
              <span className="release-no">{String(i + 1).padStart(2, '0')}</span>
            </div>
            <div className="release-copy"><p>LOADING…</p></div>
          </article>
        ))}
      </div>
    )
  }

  if (releases.length === 0) {
    return <p className="hero-copy">暂无最新发行数据。</p>
  }

  return (
    <div className="release-wall">
      {releases.map((album, i) => (
        <article className="release-item" key={album.albumId}>
          <div className={`release-art ${TONES[i % TONES.length]}`}>
            {album.coverUrl ? (
              <img src={album.coverUrl} alt={album.title} className="release-cover-img" />
            ) : (
              <span className="release-mark">B</span>
            )}
            <span className="release-no">{String(i + 1).padStart(2, '0')}</span>
          </div>
          <div className="release-copy">
            <p>{album.releaseYear}{album.avgScore > 0 ? ` · ${album.avgScore.toFixed(1)}` : ''}</p>
            <h3>{album.title}</h3>
            <span>{album.artist}</span>
          </div>
        </article>
      ))}
    </div>
  )
}
