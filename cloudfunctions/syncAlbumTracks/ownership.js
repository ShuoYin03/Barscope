'use strict'
// Ownership / featuring classification — the single source of truth for "who owns this album"
// vs "who is a featured guest". Kept pure (no DB, no network) so it is unit-testable and shared
// between syncAlbumTracks' index.js and its tests.
//
// Model:
//   ownerArtistIds  — the album's owners (drives which artist pages list it, and the Feat baseline)
//   artistIds       — every participant (owners + guests); drives the "+N" hero tag
//   feature         = artistIds − ownerArtistIds
//
// NetEase gives no owner/guest distinction at album level, so for un-corrected albums the owner set
// defaults to NetEase's album-level artists. A user-admin-correction pins the owner set deliberately.

// Pair artistIds with the names parsed from the " / "-joined artist string, by index.
function buildNameById(albumDoc) {
  albumDoc = albumDoc || {}
  const ids = Array.isArray(albumDoc.artistIds) ? albumDoc.artistIds.map(String) : []
  const names = String(albumDoc.artist || '').split('/').map(s => s.trim()).filter(Boolean)
  const map = {}
  ids.forEach((id, i) => { if (names[i]) map[id] = names[i] })
  return map
}

// Resolve { ownerIds:Set, ownerNames:Set } used to classify each track's artists.
function resolveOwners(albumDoc, neteaseArtists) {
  albumDoc = albumDoc || {}
  if (albumDoc.ownershipSource === 'user-admin-correction') {
    // ownerArtists (explicit id+name pairs) is the source of truth going forward — no positional
    // string parsing needed. Older corrections made before this field existed fall back below.
    if (Array.isArray(albumDoc.ownerArtists) && albumDoc.ownerArtists.length) {
      const ids = albumDoc.ownerArtists.map(a => String(a && a.id || '')).filter(Boolean)
      const names = albumDoc.ownerArtists.map(a => String(a && a.name || '').trim()).filter(Boolean)
      return { ownerIds: new Set(ids), ownerNames: new Set(names) }
    }
    const ids = (Array.isArray(albumDoc.ownerArtistIds) && albumDoc.ownerArtistIds.length)
      ? albumDoc.ownerArtistIds.map(String)
      : (Array.isArray(albumDoc.artistIds) ? albumDoc.artistIds.map(String) : []) // legacy: pre-migration corrections stored owners in artistIds
    const nameById = buildNameById(albumDoc)
    const names = ids.map(id => nameById[id]).filter(Boolean)
    if (!names.length && albumDoc.primaryArtist) names.push(String(albumDoc.primaryArtist).trim())
    return { ownerIds: new Set(ids.filter(Boolean)), ownerNames: new Set(names) }
  }
  const ne = (neteaseArtists || []).map(a => ({ id: String(a && a.id || ''), name: String(a && a.name || '').trim() }))
  const ownerIds = new Set(ne.map(a => a.id).filter(Boolean))
  const ownerNames = new Set(ne.map(a => a.name).filter(Boolean))
  if (!ownerNames.size && albumDoc.primaryArtist) ownerNames.add(String(albumDoc.primaryArtist).trim())
  return { ownerIds, ownerNames }
}

// Loose name key: case/whitespace/punctuation-insensitive, so "马思唯" still matches a per-track
// credit spelled with different spacing (NetEase's group-member credits are frequently inconsistent
// with the artist's own profile name) without requiring an exact byte-for-byte string match.
function normName(s) { return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[·.\-_]/g, '') }

// A track artist is a featured guest unless it is an owner — matched by id, then exact name, then
// loosely-normalized name (handles NetEase spacing/punctuation drift for the same person).
function isGuest(artist, ownerIds, ownerNames) {
  const id = String(artist && artist.id || '')
  const name = String(artist && artist.name || '').trim()
  if (id && id !== '0' && ownerIds.has(id)) return false
  if (name && ownerNames.has(name)) return false
  const normed = normName(name)
  if (normed) { for (const n of ownerNames) { if (normName(n) === normed) return false } }
  return true
}

// Feature id set = participants not among the owners.
function featureIds(allArtistIds, ownerIds) {
  return (allArtistIds || []).map(String).filter(id => !ownerIds.has(id))
}

module.exports = { buildNameById, resolveOwners, isGuest, featureIds, normName }
