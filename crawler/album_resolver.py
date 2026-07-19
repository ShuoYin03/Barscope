#!/usr/bin/env python3
"""Resolve QQ Music albums against the existing NetEase-led BarScope catalogue.

High-confidence duplicates are ignored. Ambiguous cases are flagged as possible
duplicates. Only low-match albums are treated as new candidates for review.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from difflib import SequenceMatcher
from typing import Any, Iterable


EXPLICIT_MARKERS = re.compile(
    r"\s*(?:[\(\[（【]\s*explicit\s*[\)\]）】]|[-–—:]?\s*explicit)\s*$",
    re.IGNORECASE,
)
SEPARATORS = re.compile(r"[\s\-_.·•:：()（）\[\]【】]+")


def normalise_album_title(title: str) -> str:
    """Normalize platform metadata without collapsing meaningful editions.

    Explicit markers are ignored, while Deluxe / Remastered / Anniversary labels
    are intentionally preserved because they may represent genuinely distinct releases.
    """
    value = (title or "").strip().casefold()
    previous = None
    while value != previous:
        previous = value
        value = EXPLICIT_MARKERS.sub("", value).strip()
    return SEPARATORS.sub("", value)


def _track_set(values: Iterable[str]) -> set[str]:
    from artist_resolver import normalise_track_title

    return {key for value in values if (key := normalise_track_title(value))}


@dataclass(frozen=True)
class AlbumMatchResult:
    score: float
    title_similarity: float
    same_artist: bool
    release_date_similarity: float
    track_overlap: float
    status: str
    matched_album_id: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _date_similarity(left: str, right: str) -> float:
    if not left or not right:
        return 0.5
    if left == right:
        return 1.0
    # Same year still carries weak supporting evidence.
    if left[:4] and left[:4] == right[:4]:
        return 0.6
    return 0.0


def compare_albums(candidate: dict[str, Any], existing: dict[str, Any]) -> AlbumMatchResult:
    c_title = normalise_album_title(str(candidate.get("title") or ""))
    e_title = normalise_album_title(str(existing.get("title") or ""))
    title_similarity = SequenceMatcher(None, c_title, e_title).ratio() if c_title and e_title else 0.0

    c_artist_ids = set(candidate.get("barscopeArtistIds") or candidate.get("artistIds") or [])
    e_artist_ids = set(existing.get("barscopeArtistIds") or existing.get("artistIds") or [])
    same_artist = bool(c_artist_ids and e_artist_ids and c_artist_ids & e_artist_ids)

    date_similarity = _date_similarity(
        str(candidate.get("releaseDate") or candidate.get("releaseYear") or ""),
        str(existing.get("releaseDate") or existing.get("releaseYear") or ""),
    )

    c_tracks = _track_set(candidate.get("trackTitles") or [])
    e_tracks = _track_set(existing.get("trackTitles") or [])
    smaller = min(len(c_tracks), len(e_tracks))
    track_overlap = len(c_tracks & e_tracks) / smaller if smaller else 0.0

    score = (
        title_similarity * 0.50
        + (1.0 if same_artist else 0.0) * 0.25
        + date_similarity * 0.15
        + track_overlap * 0.10
    )

    if score >= 0.85 and same_artist:
        status = "matched_ignore"
    elif score >= 0.60:
        status = "possible_duplicate"
    else:
        status = "new_album"

    return AlbumMatchResult(
        score=round(score, 4),
        title_similarity=round(title_similarity, 4),
        same_artist=same_artist,
        release_date_similarity=round(date_similarity, 4),
        track_overlap=round(track_overlap, 4),
        status=status,
        matched_album_id=str(existing.get("_id") or existing.get("sourceId") or "") or None,
    )


def resolve_album_candidate(candidate: dict[str, Any], existing_albums: Iterable[dict[str, Any]]) -> AlbumMatchResult:
    """Return the strongest existing-album match for one QQ Music candidate."""
    results = [compare_albums(candidate, album) for album in existing_albums]
    if not results:
        return AlbumMatchResult(0.0, 0.0, False, 0.0, 0.0, "new_album", None)
    return max(results, key=lambda item: item.score)
