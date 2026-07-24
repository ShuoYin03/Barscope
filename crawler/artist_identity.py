#!/usr/bin/env python3
"""Shared helpers for Soundive's cross-platform artist identity layer."""

from __future__ import annotations

import hashlib
import re
from typing import Any, Dict


ARTIST_ID_PREFIX = "bs_artist_"


def generate_barscope_artist_id(netease_artist_id: Any) -> str:
    """Generate a deterministic Soundive artist ID from the existing NetEase ID.

    The result is stable across repeated migrations and does not depend on display names,
    so later AKA/name changes will not create a new Soundive artist identity.
    """
    raw = str(netease_artist_id or "").strip()
    if not raw:
        raise ValueError("netease_artist_id is required")
    digest = hashlib.sha1(f"netease:{raw}".encode("utf-8")).hexdigest()[:12]
    return f"{ARTIST_ID_PREFIX}{digest}"


def normalise_artist_name(name: str) -> str:
    """Return a loose comparison key for artist-name matching only.

    This must never be used as the primary identity key; it is only supporting evidence.
    """
    value = (name or "").strip().casefold()
    value = re.sub(r"[\s\-_.·•/\\|()（）\[\]【】]+", "", value)
    return value


def ensure_artist_schema(record: Dict[str, Any]) -> Dict[str, Any]:
    """Return a backward-compatible artist record with the new identity schema."""
    result = dict(record)
    netease_id = result.get("id") or result.get("neteaseArtistId")
    if not netease_id:
        return result

    barscope_id = result.get("barscopeArtistId") or generate_barscope_artist_id(netease_id)
    name = str(result.get("name") or "").strip()
    aliases = result.get("aliases") or []
    if name and name not in aliases:
        aliases = [name, *aliases]

    platforms = dict(result.get("platforms") or {})
    netease = dict(platforms.get("netease") or {})
    netease.setdefault("artistId", str(netease_id))
    if name:
        netease.setdefault("name", name)
    platforms["netease"] = netease

    result["barscopeArtistId"] = barscope_id
    result["aliases"] = list(dict.fromkeys(a for a in aliases if a))
    result["platforms"] = platforms
    return result
