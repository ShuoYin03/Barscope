const cloud = require('wx-server-sdk')
const BRAND_MAP = require('./artistBrandMap')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const HIGHER_BROTHERS_IDS = new Set(['1132392', '27868624', '29303235', '29304235'])

// Same resolution order as getArtists (the Discover-page label filter): admin-managed
// brands/brand on the candidate doc win; otherwise fall back to the legacy static map. Without
// this fallback an artist's own page shows no label even though Discover correctly files them
// under it, since most artists were only ever brand-tagged via the legacy map, not the admin tool.
function cleanBrands(values) {
  const seen = new Set()
  return (Array.isArray(values) ? values : []).map(x => String(x || '').trim()).filter(x => x && !seen.has(x) && seen.add(x))
}
function resolveBrands(candidate, artistId) {
  const managedBrands = cleanBrands(candidate?.brands && candidate.brands.length ? candidate.brands : (candidate?.brand ? [candidate.brand] : []))
  const legacyBrand = BRAND_MAP[String(artistId)] || ''
  const brands = managedBrands.length ? managedBrands : (legacyBrand ? [legacyBrand] : [])
  if (HIGHER_BROTHERS_IDS.has(String(artistId)) && !brands.includes('成都集团')) brands.push('成都集团')
  return brands
}

exports.main = async (event) => {
  const artistId = event.artistId   // neteaseArtistId string
  if (!artistId) return { success: false, error: 'missing artistId' }

  try {
    // Newer artist profiles may live in artists; approved crawl candidates keep picUrl.
    const [artistRes, candidateRes] = await Promise.all([
      db.collection('artists')
        .where({ neteaseArtistId: String(artistId) })
        .limit(1)
        .get()
        .catch(() => ({ data: [] })),
      db.collection('artist_candidates')
        .where({ artistId: Number(artistId), status: 'approved' })
        .limit(1)
        .get()
        .catch(() => ({ data: [] })),
    ])

    const artist = artistRes.data[0] || null
    const candidate = candidateRes.data[0] || null

    if (!artist && !candidate) return { success: true, artist: null }

    const avatarUrl = artist?.avatarUrl || artist?.picUrl || candidate?.avatarUrl || candidate?.picUrl || ''
    const heroImageUrl = artist?.heroImageUrl || artist?.backgroundUrl || artist?.coverUrl || candidate?.heroImageUrl || candidate?.backgroundUrl || candidate?.coverUrl || avatarUrl || ''
    const brands = resolveBrands(candidate, artistId)

    return {
      success: true,
      artist: {
        ...(candidate || {}),
        ...(artist || {}),
        artistId: artist?.artistId || candidate?.artistId || Number(artistId),
        artistName: artist?.artistName || artist?.name || candidate?.artistName || '',
        picUrl: avatarUrl,
        avatarUrl,
        backgroundUrl: heroImageUrl,
        coverUrl: heroImageUrl,
        heroImageUrl,
        brand: brands[0] || '',
        brands,
      },
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
}
