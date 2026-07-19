'use strict'
// Ownership / featuring classification — the single source of truth for "who owns this album"
// vs "who is a featured guest".
//
// Model:
//   ownerArtistIds  — true album owners; drives which artist pages list the album and the Feat baseline
//   artistIds       — every participant (owners + guests); drives the "+N" hero tag only
//   feature         = artistIds − ownerArtistIds
//
// IMPORTANT: artistIds must NEVER be used as the owner fallback for an uncorrected album. Historical
// data may already contain track-level guests in artistIds, and treating that field as ownership is
// exactly what cross-lists an album onto featured artists' pages.

function buildNameById(albumDoc) {
  albumDoc = albumDoc || {}
  const ids = Array.isArray(albumDoc.artistIds) ? albumDoc.artistIds.map(String) : []
  const names = String(albumDoc.artist || '').split('/').map(s => s.trim()).filter(Boolean)
  const map = {}
  ids.forEach((id, i) => { if (names[i]) map[id] = names[i] })
  return map
}

function resolveOwners(albumDoc, neteaseArtists) {
  albumDoc = albumDoc || {}

  // Admin-corrected ownership is pinned and always wins.
  if (albumDoc.ownershipSource === 'user-admin-correction') {
    if (Array.isArray(albumDoc.ownerArtists) && albumDoc.ownerArtists.length) {
      const pairs = albumDoc.ownerArtists
        .map(a => ({ id: String(a && a.id || ''), name: String(a && a.name || '').trim() }))
        .filter(a => a.name)
      return toResult(pairs)
    }

    const ids = (Array.isArray(albumDoc.ownerArtistIds) && albumDoc.ownerArtistIds.length)
      ? albumDoc.ownerArtistIds.map(String)
      : (Array.isArray(albumDoc.artistIds) ? albumDoc.artistIds.map(String) : [])
    const nameById = buildNameById(albumDoc)
    const pairs = ids.map(id => ({ id, name: nameById[id] || '' })).filter(a => a.name)
    if (!pairs.length && albumDoc.primaryArtist) pairs.push({ id: '', name: String(albumDoc.primaryArtist).trim() })
    return toResult(pairs)
  }

  // For uncorrected albums, use NetEase's ALBUM-LEVEL artist credits as the owner set.
  // Do not trust albumDoc.artistIds here: that field intentionally contains owners + guests and may
  // have been polluted by older sync logic. A subsequent sync will therefore repair ownerArtistIds.
  const pairs = (neteaseArtists || [])
    .map(a => ({ id: String(a && a.id || ''), name: String(a && a.name || '').trim() }))
    .filter(a => a.name)

  if (!pairs.length) {
    // Safe fallback: an explicit stored owner set is preferable to the all-participant artistIds field.
    if (Array.isArray(albumDoc.ownerArtists) && albumDoc.ownerArtists.length) {
      return toResult(albumDoc.ownerArtists
        .map(a => ({ id: String(a && a.id || ''), name: String(a && a.name || '').trim() }))
        .filter(a => a.name))
    }
    if (albumDoc.primaryArtist) return toResult([{ id: String(albumDoc.neteaseArtistId || ''), name: String(albumDoc.primaryArtist).trim() }])
  }

  return toResult(pairs)
}

function toResult(pairs) {
  return {
    ownerIds: new Set(pairs.map(p => p.id).filter(Boolean)),
    ownerNames: new Set(pairs.map(p => p.name)),
    ownerArtists: pairs.map(p => ({ id: Number(p.id) || 0, name: p.name })),
  }
}

function normName(s) { return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[·.\-_]/g, '') }

function isGuest(artist, ownerIds, ownerNames) {
  const id = String(artist && artist.id || '')
  const name = String(artist && artist.name || '').trim()
  if (id && id !== '0' && ownerIds.has(id)) return false
  if (name && ownerNames.has(name)) return false
  const normed = normName(name)
  if (normed) { for (const n of ownerNames) { if (normName(n) === normed) return false } }
  return true
}

function featureIds(allArtistIds, ownerIds) {
  return (allArtistIds || []).map(String).filter(id => !ownerIds.has(id))
}

module.exports = { buildNameById, resolveOwners, isGuest, featureIds, normName }
