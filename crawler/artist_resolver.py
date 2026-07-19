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


TRACK_VERSION_SUFFIX = re.compile(
    r"\s*(?:[\(\[（【].*?(?:伴奏|inst(?:rumental)?|instrumental|remix|demo|live|explicit).*?[\)\]）】]|"
    r"[-–—:]\s*(?:伴奏|inst(?:rumental)?|instrumental|remix|demo|live).*)$",
    re.IGNORECASE,
)


def normalise_track_title(title: str) -> str:
    value = (title or "").strip().casefold()
    value = TRACK_VERSION_SUFFIX.sub("", value)
    value = re.sub(r"[\s\-_.·•:：()（）\[\]【】]+", "", value)
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

    Track overlap uses the smaller catalogue as denominator. This handles platform
    exclusives and incomplete catalogues better than dividing by the larger catalogue.
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

    # Songs remain the dominant signal; names help only when catalogues are sparse.
    score = min(1.0, track_overlap * 0.9 + name_similarity * 0.1)

    if track_overlap >= 0.80 and matched >= 3:
        status = "matched"
    elif track_overlap >= 0.50 and matched >= 2:
        status = "review"
    elif score >= 0.72 and matched >= 2:
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
