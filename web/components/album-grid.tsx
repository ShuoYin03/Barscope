'use client'

import { useEffect, useState } from 'react'
import { callFunction } from '@/lib/cloudbase'

interface AlbumDoc {
  _id: string
  title: string
  artist: string
  primaryArtist?: string
  releaseYear: number
  coverUrl: string
  avgScore: number
}

const YEARS = ['ALL', '2026', '2025', '2024', '2023', '2022']
const PAGE_SIZE = 24

function fmtScore(n: number) {
  if (!n) return null
  const r = Math.round(n * 10) / 10
  return r === 10 ? '10' : r.toFixed(1)
}

export function AlbumGrid() {
  const [year, setYear] = useState('ALL')
  const [albums, setAlbums] = useState<AlbumDoc[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    callFunction<{ success: boolean; list?: AlbumDoc[]; total?: number }>('getAlbums', {
      year,
      page: 1,
      pageSize: PAGE_SIZE,
      sortBy: 'yearRatedFirst',
    })
      .then((r) => {
        if (cancelled) return
        setAlbums(r.success ? (r.list || []) : [])
        setTotal(r.success ? (r.total || 0) : 0)
        setPage(1)
        setLoading(false)
      })
      .catch(() => { if (!cancelled) { setAlbums([]); setTotal(0); setLoading(false) } })
    return () => { cancelled = true }
  }, [year])

  function loadMore() {
    const nextPage = page + 1
    setLoading(true)
    callFunction<{ success: boolean; list?: AlbumDoc[]; total?: number }>('getAlbums', {
      year,
      page: nextPage,
      pageSize: PAGE_SIZE,
      sortBy: 'yearRatedFirst',
    })
      .then((r) => {
        setAlbums((prev) => [...prev, ...(r.success ? (r.list || []) : [])])
        setPage(nextPage)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }

  const hasMore = albums.length < total

  return (
    <>
      <div className="filter-row">
        {YEARS.map((y) => (
          <button key={y} className={`filter-chip ${year === y ? 'active' : ''}`} onClick={() => setYear(y)}>
            {y}
          </button>
        ))}
      </div>

      {loading && albums.length === 0 ? (
        <div className="catalog-empty">加载中…</div>
      ) : albums.length === 0 ? (
        <div className="catalog-empty">没有找到相关专辑。</div>
      ) : (
        <div className="catalog-grid">
          {albums.map((album) => {
            const score = fmtScore(album.avgScore)
            return (
              <article className="catalog-card" key={album._id}>
                <div className="catalog-cover">
                  {album.coverUrl ? <img src={album.coverUrl} alt={album.title} /> : null}
                  {score ? <span className="catalog-score">{score}</span> : <span className="catalog-score unrated">UNRATED</span>}
                </div>
                <div className="catalog-copy">
                  <h3>{album.title}</h3>
                  <span>{album.artist || album.primaryArtist} · {album.releaseYear}</span>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {albums.length > 0 && (
        <div className="load-more-row">
          {hasMore ? (
            <button className="load-more-btn" onClick={loadMore} disabled={loading}>
              {loading ? 'LOADING…' : 'LOAD MORE'}
            </button>
          ) : (
            <span className="load-more-done">— {total} ALBUMS —</span>
          )}
        </div>
      )}
    </>
  )
}
