/**
 * 一次性迁移云函数：将 1-5 评分体系迁移至 1-10 体系
 * 操作：所有 reviews.rating × 2，所有 albums.avgScore × 2
 * 迁移完成后可删除此云函数。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { dryRun = true } = event  // 默认 dry-run，需显式传 dryRun:false 才真正写入

  try {
    // ── Step 1: 迁移所有 reviews ─────────────────────────────
    let reviewsUpdated = 0
    let reviewOffset   = 0
    const PAGE = 100

    while (true) {
      const { data: batch } = await db.collection('reviews')
        .skip(reviewOffset)
        .limit(PAGE)
        .get()

      if (batch.length === 0) break

      if (!dryRun) {
        await Promise.all(batch.map(r => {
          const newRating = Math.min(Math.round((r.rating || 1) * 2), 10)
          return db.collection('reviews').doc(r._id).update({
            data: { rating: newRating },
          })
        }))
      }

      reviewsUpdated += batch.length
      reviewOffset   += batch.length
      if (batch.length < PAGE) break
    }

    // ── Step 2: 迁移所有 albums avgScore ────────────────────
    let albumsUpdated = 0
    let albumOffset   = 0

    while (true) {
      const { data: batch } = await db.collection('albums')
        .where({ avgScore: _.gt(0) })
        .skip(albumOffset)
        .limit(PAGE)
        .get()

      if (batch.length === 0) break

      if (!dryRun) {
        await Promise.all(batch.map(a => {
          const newScore = Math.min(Math.round(a.avgScore * 2 * 10) / 10, 10)
          return db.collection('albums').doc(a._id).update({
            data: { avgScore: newScore },
          })
        }))
      }

      albumsUpdated += batch.length
      albumOffset   += batch.length
      if (batch.length < PAGE) break
    }

    return {
      success:        true,
      dryRun,
      reviewsUpdated,
      albumsUpdated,
      message:        dryRun
        ? `[DRY RUN] 将迁移 ${reviewsUpdated} 条评论，${albumsUpdated} 张专辑`
        : `已迁移 ${reviewsUpdated} 条评论，${albumsUpdated} 张专辑`,
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
