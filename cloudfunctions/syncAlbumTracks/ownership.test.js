'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resolveOwners, buildNameById, isGuest, featureIds } = require('./ownership')

// Real fixtures drawn from the cloud DB.
// 幸存者的负罪感 — a genuine 王以太 × 艾热 joint album (two co-owners, never corrected).
const JOINT = {
  ownershipSource: undefined,
  primaryArtist: '王以太',
  artist: '王以太 / 艾热 AIR',
  artistIds: ['12236125', '1203045'],
}
const JOINT_NE = [ { id: 12236125, name: '王以太' }, { id: 1203045, name: '艾热 AIR' } ]

// The Collections（集）— 付思遥 project; 4 per-track collaborators are features, not owners.
// After correction: owner set pinned to 付思遥 only, artistIds still carries all 5 participants.
const COMP = {
  ownershipSource: 'user-admin-correction',
  primaryArtist: '付思遥',
  artist: '付思遥 / 艾志恒Asen / THOME / mac ova seas / CashTrippy',
  ownerArtistIds: ['51088331'],
  artistIds: ['51088331', '12198387', '12110173', '30704161', '33937972'],
}
const COMP_NE = [
  { id: 51088331, name: '付思遥' }, { id: 12198387, name: '艾志恒Asen' },
  { id: 12110173, name: 'THOME' }, { id: 30704161, name: 'mac ova seas' },
  { id: 33937972, name: 'CashTrippy' },
]

test('buildNameById pairs artistIds with names split from the artist string by index', () => {
  assert.deepEqual(buildNameById(COMP), {
    '51088331': '付思遥', '12198387': '艾志恒Asen', '12110173': 'THOME',
    '30704161': 'mac ova seas', '33937972': 'CashTrippy',
  })
})

test('uncorrected album: owners follow NetEase album-level artists (both co-owners)', () => {
  const { ownerIds, ownerNames } = resolveOwners(JOINT, JOINT_NE)
  assert.deepEqual([...ownerIds].sort(), ['12236125', '1203045'].sort())
  assert.deepEqual([...ownerNames].sort(), ['王以太', '艾热 AIR'].sort())
})

test('corrected album: owners pinned to ownerArtistIds, NOT NetEase 5-artist list', () => {
  const { ownerIds, ownerNames } = resolveOwners(COMP, COMP_NE)
  assert.deepEqual([...ownerIds], ['51088331'])
  assert.deepEqual([...ownerNames], ['付思遥'])
})

test('corrected album missing ownerArtistIds (legacy): falls back to artistIds', () => {
  const legacy = { ...COMP, ownerArtistIds: undefined }
  const { ownerIds } = resolveOwners(legacy, COMP_NE)
  assert.deepEqual([...ownerIds].sort(), COMP.artistIds.slice().sort())
})

test('corrected album with ownerArtists: names come from the explicit list, not positional string parsing', () => {
  // A participant promoted from guest to owner is not "newly added" to artistIds, so the artist
  // string may not stay position-aligned with artistIds. ownerArtists must not depend on that.
  const promoted = { ...COMP, artist: '付思遥', ownerArtists: [{ id: '51088331', name: '付思遥' }, { id: '12198387', name: '艾志恒Asen' }] }
  const { ownerIds, ownerNames } = resolveOwners(promoted, COMP_NE)
  assert.deepEqual([...ownerIds].sort(), ['12198387', '51088331'])
  assert.deepEqual([...ownerNames].sort(), ['付思遥', '艾志恒Asen'].sort())
})

test('joint album: neither co-owner is a guest on a shared track', () => {
  const { ownerIds, ownerNames } = resolveOwners(JOINT, JOINT_NE)
  const track = [ { id: 12236125, name: '王以太' }, { id: 1203045, name: '艾热 AIR' } ]
  assert.equal(track.some(a => isGuest(a, ownerIds, ownerNames)), false)
})

test('joint album: an outside collaborator on a track IS a guest', () => {
  const { ownerIds, ownerNames } = resolveOwners(JOINT, JOINT_NE)
  assert.equal(isGuest({ id: 999, name: '路人' }, ownerIds, ownerNames), true)
})

test('compilation: the per-track collaborator is a Feat guest after correction', () => {
  const { ownerIds, ownerNames } = resolveOwners(COMP, COMP_NE)
  // Track 1「版图」performers: 付思遥 / 艾志恒Asen
  assert.equal(isGuest({ id: 51088331, name: '付思遥' }, ownerIds, ownerNames), false)
  assert.equal(isGuest({ id: 12198387, name: '艾志恒Asen' }, ownerIds, ownerNames), true)
})

test('isGuest matches owner by name even when the track artist id is missing/zero', () => {
  const { ownerIds, ownerNames } = resolveOwners(COMP, COMP_NE)
  assert.equal(isGuest({ id: 0, name: '付思遥' }, ownerIds, ownerNames), false)
})

test('isGuest matches owner by name despite spacing/punctuation drift between NetEase track credits and the artist picker', () => {
  // Higher Brothers case: a group member is picked as an owner via the admin picker (clean name from
  // artist_candidates), but NetEase's per-track credit for the same person uses a different id and a
  // slightly different-formatted name — exact string/id match fails, loose match must still succeed.
  const ownerIds = new Set(['1'])
  const ownerNames = new Set(['马思唯'])
  assert.equal(isGuest({ id: 99999, name: ' 马思唯 ' }, ownerIds, ownerNames), false)
  assert.equal(isGuest({ id: 99999, name: '马思唯·' }, ownerIds, ownerNames), false)
  assert.equal(isGuest({ id: 99999, name: '路人' }, ownerIds, ownerNames), true)
})

test('featureIds is participants minus owners', () => {
  const { ownerIds } = resolveOwners(COMP, COMP_NE)
  assert.deepEqual(featureIds(COMP.artistIds, ownerIds), ['12198387', '12110173', '30704161', '33937972'])
})

test('featureIds is empty when every participant co-owns the album', () => {
  const { ownerIds } = resolveOwners(JOINT, JOINT_NE)
  assert.deepEqual(featureIds(JOINT.artistIds, ownerIds), [])
})

test('uncorrected album with no NetEase artists falls back to stored primaryArtist as owner name', () => {
  const doc = { primaryArtist: '某人', artist: '某人', artistIds: ['1'] }
  const { ownerNames } = resolveOwners(doc, [])
  assert.equal(ownerNames.has('某人'), true)
})

// 最高 — Higher Brothers EP, never corrected. Crawl-time artistIds correctly holds all 5
// collaborators (group + 4 members, from NetEase's artist-discography endpoint), but a later live
// re-fetch of the album-detail endpoint only returns the group — a real, observed NetEase
// inconsistency between its two endpoints for the same album.
const HIGHEST = {
  ownershipSource: undefined,
  primaryArtist: 'Higher Brothers',
  artist: 'Higher Brothers / 马思唯 / KnowKnow / PSY.P / Melo',
  artistIds: ['12002201', '1132392', '27868624', '29303235', '29304235'],
}
const HIGHEST_NE_NARROW = [ { id: 12002201, name: 'Higher Brothers' } ]

test('uncorrected album: stored artistIds wins over a narrower live NetEase re-fetch', () => {
  const { ownerIds, ownerNames } = resolveOwners(HIGHEST, HIGHEST_NE_NARROW)
  assert.deepEqual([...ownerIds].sort(), HIGHEST.artistIds.slice().sort())
  assert.equal(ownerNames.has('马思唯'), true)
  assert.equal(ownerNames.has('KnowKnow'), true)
})

test('isGuest: a group member is not a Feat guest once resolveOwners trusts the stored artistIds', () => {
  const { ownerIds, ownerNames } = resolveOwners(HIGHEST, HIGHEST_NE_NARROW)
  assert.equal(isGuest({ id: 1132392, name: '马思唯' }, ownerIds, ownerNames), false)
  assert.equal(isGuest({ id: 27868624, name: 'KnowKnow' }, ownerIds, ownerNames), false)
})
