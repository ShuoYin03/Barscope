#!/usr/bin/env python3
"""Small NetEase Music client for cross-platform artist resolution."""

from __future__ import annotations

from typing import Any
import time

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


ARTIST_DETAIL_URL = "https://music.163.com/api/v1/artist/{artist_id}"


class NetEaseMusicError(RuntimeError):
    pass


class NetEaseMusicClient:
    def __init__(
        self,
        timeout: float = 15.0,
        session: requests.Session | None = None,
        retries: int = 5,
        backoff_factor: float = 1.0,
    ):
        self.timeout = timeout
        self.session = session or requests.Session()

        retry_policy = Retry(
            total=max(0, retries),
            connect=max(0, retries),
            read=max(0, retries),
            status=max(0, retries),
            backoff_factor=max(0.0, backoff_factor),
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset({"GET"}),
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry_policy)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)

        self.session.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/131.0 Safari/537.36"
                ),
                "Referer": "https://music.163.com/",
                "Accept": "application/json,text/plain,*/*",
            }
        )

    def _get_json(self, url: str, **kwargs: Any) -> dict[str, Any]:
        response = self.session.get(url, timeout=self.timeout, **kwargs)
        response.raise_for_status()
        try:
            return response.json()
        except ValueError as exc:
            raise NetEaseMusicError("NetEase Music returned a non-JSON response") from exc

    def get_artist_tracks(self, artist_id: str | int, limit: int = 100) -> list[str]:
        """Return the artist page's available hot-track titles.

        NetEase's public artist payload exposes a hotSongs list. This is intentionally
        isolated behind a client method so a future full-catalogue endpoint can replace
        it without changing the resolver pipeline.
        """
        data = self._get_json(ARTIST_DETAIL_URL.format(artist_id=artist_id))
        if data.get("code") not in (None, 200):
            raise NetEaseMusicError(f"NetEase artist endpoint returned code {data.get('code')}")

        songs = data.get("hotSongs", []) or []
        titles: list[str] = []
        seen: set[str] = set()
        for song in songs:
            title = str(song.get("name") or "").strip()
            if not title or title in seen:
                continue
            seen.add(title)
            titles.append(title)
            if len(titles) >= max(1, limit):
                break
        return titles
