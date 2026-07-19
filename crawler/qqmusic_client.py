#!/usr/bin/env python3
"""Small QQ Music client used by the BarScope cross-platform resolver.

QQ Music does not expose a documented public developer API for this workflow, so
all endpoint details live in this module and can be swapped without touching the
matching pipeline.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, asdict
from typing import Any

import requests


MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"


@dataclass(frozen=True)
class QQArtistCandidate:
    artist_id: str
    mid: str
    name: str
    song_count: int = 0
    album_count: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


class QQMusicError(RuntimeError):
    pass


class QQMusicClient:
    def __init__(self, timeout: float = 15.0, session: requests.Session | None = None):
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/131.0 Safari/537.36"
                ),
                "Referer": "https://y.qq.com/",
                "Origin": "https://y.qq.com",
            }
        )

    def _post_musicu(self, payload: dict[str, Any]) -> dict[str, Any]:
        response = self.session.post(MUSICU_URL, json=payload, timeout=self.timeout)
        response.raise_for_status()
        try:
            return response.json()
        except ValueError as exc:
            raise QQMusicError("QQ Music returned a non-JSON response") from exc

    def search_artists(self, keyword: str, limit: int = 10) -> list[QQArtistCandidate]:
        """Search QQ Music and return singer candidates only."""
        payload = {
            "comm": {"ct": "19", "cv": "1859", "uin": "0"},
            "req": {
                "module": "music.search.SearchCgiService",
                "method": "DoSearchForQQMusicDesktop",
                "param": {
                    "query": keyword,
                    "search_type": 1,
                    "num_per_page": max(1, min(limit, 30)),
                    "page_num": 1,
                },
            },
        }
        data = self._post_musicu(payload)
        body = data.get("req", {}).get("data", {}).get("body", {})
        singer_block = body.get("singer", {})
        items = singer_block.get("list", []) or []

        candidates: list[QQArtistCandidate] = []
        seen: set[str] = set()
        for raw in items:
            singer = raw.get("singer", raw)
            mid = str(
                singer.get("singerMID")
                or singer.get("mid")
                or singer.get("singer_mid")
                or ""
            ).strip()
            numeric_id = str(
                singer.get("singerID")
                or singer.get("id")
                or singer.get("singer_id")
                or ""
            ).strip()
            name = html.unescape(
                str(
                    singer.get("singerName")
                    or singer.get("name")
                    or singer.get("singer_name")
                    or ""
                )
            ).strip()
            stable_key = mid or numeric_id
            if not stable_key or not name or stable_key in seen:
                continue
            seen.add(stable_key)
            candidates.append(
                QQArtistCandidate(
                    artist_id=numeric_id,
                    mid=mid,
                    name=re.sub(r"<[^>]+>", "", name),
                    song_count=int(singer.get("songNum") or singer.get("song_num") or 0),
                    album_count=int(singer.get("albumNum") or singer.get("album_num") or 0),
                )
            )
        return candidates[:limit]

    def get_artist_tracks(self, singer_mid: str, limit: int = 100) -> list[str]:
        """Fetch track titles for a QQ singer MID via musicu.fcg."""
        page_size = max(1, min(limit, 300))
        payload = {
            "comm": {"ct": 24, "cv": 0},
            "singerSongList": {
                "module": "musichall.song_list_server",
                "method": "GetSingerSongList",
                "param": {
                    "order": 1,
                    "singerMid": singer_mid,
                    "begin": 0,
                    "num": page_size,
                },
            },
        }
        data = self._post_musicu(payload)
        block = data.get("singerSongList", {})
        code = block.get("code", 0)
        if code not in (0, None):
            raise QQMusicError(f"QQ Music singer-track request failed with code {code}")

        song_rows = block.get("data", {}).get("songList", []) or []
        titles: list[str] = []
        for item in song_rows:
            song_info = item.get("songInfo", item)
            title = str(song_info.get("title") or song_info.get("songname") or "").strip()
            if title:
                titles.append(title)
        return titles
