#!/usr/bin/env python3
"""Cross-platform artist matching utilities.

Primary signal: overlap between released tracks on both platforms.
Artist names are supporting evidence only because AKA differences are common.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, asdict
from difflib import SequenceMatcher
from typing import Iterable, Sequence

from artist_identity import normalise_artist_name


# Remove platform/version decorations that frequently differ for the same recording.
# Keep meaningful subtitles unless they clearly describe a version or featured credits.
TRAILING_DECORATION = re.compile(
    r"\s*(?:"
    r"[\(\[（【][^\)\]）】]*(?:"
    r"feat(?:uring)?\.?|ft\.?|with|prod(?:uced)?\.?|制作人|伴奏|"
    r"inst(?:rumental)?|instrumental|remix|demo|live|explicit|clean|"
    r"remaster(?:ed)?|version|版"
    r")[^\)\]）】]*[\)\]）】]"
    r"|[-–—:：]\s*(?:"
    r"feat(?:uring)?\.?|ft\.?|prod(?:uced)?\.?|伴奏|"
    r"inst(?:rumental)?|instrumental|remix|demo|live|explicit|clean|"
    r"remaster(?:ed)?|version|版"
    r").*"
    r")$",
    re.IGNORECASE,
)

FEAT_INLINE = re.compile(
    r"\s+(?:feat(?:uring)?\.?|ft\.?)\s+.+$",
    re.IGNORECASE,
)


def normalise_track_title(title: str) -> str:
    """Return a conservative cross-platform comparison key for a track title."""
    value = (title or "").strip().casefold()
    value = FEAT_INLINE.sub("", value)

    # Decorations can be stacked, e.g. "Song (feat. X) [Explicit]".
    previous = None
    while value != previous:
        previous = value
        value = TRAILING_DECORATION.sub("", value).strip()

    # Ignore punctuation/spacing differences without deleting letters or numbers.
    value = re.sub(r"[\s\-_.·•:：'’‘\"“”`~!！?？,，/\\|]+", "", value)
    value = re.sub(r"[()（）\[\]【】{}<>《》]", "", value)
    return value


def _normalised_set(values: Iterable[str]) -> set[str]:
    return {key for value in values if (key := normalise_track_title(value))}


@dataclass(frozen=True)
class ArtistMatchResult:
    score: float
    track_overlap: float
    name_similarity: float
    matched_tracks: int
    netease_track_count: int
    qq_track_count: int
    status: str

    def to_dict(self) -> dict:
        return asdict(self)


def resolve_artist_match(
    netease_tracks: Sequence[str],
    qq_tracks: Sequence[str],
    netease_name: str = "",
    qq_name: str = "",
) -> ArtistMatchResult:
    """Score whether two platform artist accounts represent the same artist.

    Absolute matching-track count is intentionally a strong signal. Platform
    catalogues are often incomplete, differently ordered, or partially unavailable,
    so a large number of identical released titles can be stronger evidence than a
    percentage calculated from two unequal catalogue snapshots.
    """
    ne = _normalised_set(netease_tracks)
    qq = _normalised_set(qq_tracks)
    matched = len(ne & qq)
    smaller = min(len(ne), len(qq))
    track_overlap = matched / smaller if smaller else 0.0

    ne_name = normalise_artist_name(netease_name)
    qq_name = normalise_artist_name(qq_name)
    name_similarity = (
        SequenceMatcher(None, ne_name, qq_name).ratio() if ne_name and qq_name else 0.0
    )

    # The display score remains useful for ranking, while the status rules below
    # explicitly recognise strong absolute catalogue overlap.
    absolute_evidence = min(1.0, matched / 15.0)
    score = min(
        1.0,
        track_overlap * 0.55 + absolute_evidence * 0.35 + name_similarity * 0.10,
    )

    # Very strong absolute evidence: 15 identical titles is enough to auto-bind,
    # even when one platform exposes only a partial catalogue snapshot.
    if matched >= 15:
        status = "matched"
    # Strong combined evidence for smaller catalogues / newer artists.
    elif matched >= 8 and name_similarity >= 0.65:
        status = "matched"
    elif track_overlap >= 0.70 and matched >= 3 and name_similarity >= 0.50:
        status = "matched"
    # Plausible candidates stay in review rather than being discarded.
    elif matched >= 5:
        status = "review"
    elif track_overlap >= 0.30 and matched >= 3:
        status = "review"
    elif matched >= 2 and name_similarity >= 0.85:
        status = "review"
    else:
        status = "unmatched"

    return ArtistMatchResult(
        score=round(score, 4),
        track_overlap=round(track_overlap, 4),
        name_similarity=round(name_similarity, 4),
        matched_tracks=matched,
        netease_track_count=len(ne),
        qq_track_count=len(qq),
        status=status,
    )
