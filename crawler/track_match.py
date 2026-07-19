#!/usr/bin/env python3
"""Cross-platform track title/duration matching shared by the QQ<->NetEase dedupe tools.

QQ Music track titles are frequently "dirty" compared to the same song's NetEase title —
carrying suffixes like "(Live)"、"(伴奏)"、"(DJ Remix)"、"【首发】" that a plain string
comparison treats as a different song entirely. Stripping known noise patterns before
comparing, and backing the title check with duration (which dirty tags don't change,
whereas a genuinely different version like a Live cut usually does), gives a much more
reliable "is this actually the same track" signal than either alone.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any, Iterable

# Bracketed/parenthetical noise: platform tags, mix/version labels, quality markers.
# Matched case-insensitively against the content *inside* (), [],【】,《》 pairs.
_DIRTY_BRACKET_PATTERNS = [
    r"live", r"伴奏", r"纯音乐", r"dj\s*remix", r"remix", r"explicit", r"clean",
    r"独家", r"首发", r"抢先", r"官方", r"live\s*版", r"现场版", r"未剪辑版",
    r"deluxe", r"remaster(ed)?", r"instrumental", r"karaoke", r"demo",
    r"feat\.?.*", r"ft\.?.*", r"with\s+.*",
]
_BRACKET_RE = re.compile(r"[（(【\[《][^）)】\]》]*[）)】\]》]")
_DIRTY_BRACKET_RE = re.compile(
    r"[（(【\[《]\s*(?:" + "|".join(_DIRTY_BRACKET_PATTERNS) + r")[^）)】\]》]*[）)】\]》]",
    re.IGNORECASE,
)
_PUNCT_RE = re.compile(r"[\s　.,，。:：;；!！?？'\"“”‘’_\-·•/\\]+")


def strip_dirty_tags(title: str) -> str:
    """Remove bracketed platform/version noise, keeping brackets that carry real title info
    (e.g. a genuine subtitle) by only stripping brackets whose content matches a known
    dirty-tag pattern."""
    text = str(title or "")
    return _DIRTY_BRACKET_RE.sub("", text).strip()


def normalize_track_title(title: str) -> str:
    """Dirty-tag-stripped, punctuation/whitespace-insensitive, lowercased title key."""
    cleaned = strip_dirty_tags(title)
    return _PUNCT_RE.sub("", cleaned.lower())


def normalize_track_title_loose(title: str) -> str:
    """Fallback when strip_dirty_tags over-strips (e.g. the whole title was bracketed):
    just drop ALL bracketed content, dirty or not."""
    text = _BRACKET_RE.sub("", str(title or ""))
    return _PUNCT_RE.sub("", text.lower())


def _title_key(title: str) -> str:
    key = normalize_track_title(title)
    return key if key else normalize_track_title_loose(title)


def _get(track: Any, key: str, default: Any = None) -> Any:
    if isinstance(track, dict):
        return track.get(key, default)
    return getattr(track, key, default)


def track_title(track: Any) -> str:
    return str(_get(track, "title") or _get(track, "name") or "").strip()


def track_duration_ms(track: Any) -> int:
    for key in ("duration_ms", "duration", "dt"):
        value = _get(track, key)
        if value:
            try:
                return int(value)
            except (TypeError, ValueError):
                continue
    return 0


def tracks_match(a: Any, b: Any, duration_tolerance_ms: int = 4000) -> bool:
    """Same song if normalized titles match; duration (when both sides have one) must also
    be within tolerance, so a dirty-tag-stripped title match doesn't wrongly conflate two
    genuinely different versions (e.g. studio vs. a still-dirty-after-stripping Live tag)."""
    key_a, key_b = _title_key(track_title(a)), _title_key(track_title(b))
    if not key_a or not key_b or key_a != key_b:
        return False
    dur_a, dur_b = track_duration_ms(a), track_duration_ms(b)
    if dur_a and dur_b and abs(dur_a - dur_b) > duration_tolerance_ms:
        return False
    return True


def overlap_ratio(qq_tracks: Iterable[Any], reference_tracks: Iterable[Any], duration_tolerance_ms: int = 4000) -> float:
    """Fraction of qq_tracks that have a matching track somewhere in reference_tracks.
    1.0 means every QQ track was found on the reference side (near-certain duplicate);
    0.0 means none were (the strongest "this looks QQ-exclusive" signal)."""
    qq_list = list(qq_tracks)
    if not qq_list:
        return 0.0
    ref_list = list(reference_tracks)
    if not ref_list:
        return 0.0
    matched = 0
    for qt in qq_list:
        if any(tracks_match(qt, rt, duration_tolerance_ms) for rt in ref_list):
            matched += 1
    return matched / len(qq_list)


def title_similarity(a: str, b: str) -> float:
    ka, kb = _title_key(a), _title_key(b)
    if not ka or not kb:
        return 0.0
    if ka == kb:
        return 1.0
    if min(len(ka), len(kb)) <= 2:
        return 0.0
    return SequenceMatcher(None, ka, kb).ratio()
