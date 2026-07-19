#!/usr/bin/env python3
"""Small QQ Music client used by the BarScope cross-platform resolver."""

from __future__ import annotations

import html
import re
from dataclasses import asdict, dataclass
from typing import Any

import requests


MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"
LEGACY_SINGER_ALBUM_URL = "https://c.y.qq.com/v8/fcg-bin/fcg_v8_singer_album.fcg"
LEGACY_ALBUM_INFO_URL = "https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg"


@dataclass(frozen=True)
class QQArtistCandidate:
    artist_id: str
    mid: str
    name: str
    song_count: int = 0
    album_count: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class QQTrack:
    title: str
    duration_ms: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class QQAlbum:
    album_id: str
    mid: str
    title: str
    artist_name: str
    artist_mid: str
    publish_date: str = ""
    track_count: int = 0
    cover_url: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class QQMusicError(RuntimeError):
    pass


class QQMusicClient:
    def __init__(self, timeout: float = 15.0, session: requests.Session | None = None):
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
            ),
            "Referer": "https://y.qq.com/",
            "Origin": "https://y.qq.com",
        })

    def _post_musicu(self, payload: dict[str, Any]) -> dict[str, Any]:
        response = self.session.post(MUSICU_URL, json=payload, timeout=self.timeout)
        response.raise_for_status()
        try:
            return response.json()
        except ValueError as exc:
            raise QQMusicError("QQ Music returned a non-JSON response") from exc

    def _get_legacy_album_payload(self, album_mid: str) -> dict[str, Any]:
        response = self.session.get(
            LEGACY_ALBUM_INFO_URL,
            params={"albummid": album_mid, "format": "json", "platform": "yqq", "newsong": 1},
            timeout=self.timeout,
        )
        response.raise_for_status()
        try:
            return response.json()
        except ValueError as exc:
            raise QQMusicError("QQ Music album-info endpoint returned non-JSON") from exc

    @staticmethod
    def _find_publish_date(value: Any) -> str:
        """Recursively find a usable release date across QQ's changing response shapes."""
        preferred_keys = (
            "pub_time", "publish_date", "publishDate", "publicTime", "publictime",
            "release_date", "releaseDate", "date", "time_public",
        )
        if isinstance(value, dict):
            for key in preferred_keys:
                raw = value.get(key)
                if raw is not None:
                    text = str(raw).strip()
                    if re.search(r"(?:19|20)\d{2}", text):
                        return text
            for child in value.values():
                found = QQMusicClient._find_publish_date(child)
                if found:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = QQMusicClient._find_publish_date(child)
                if found:
                    return found
        return ""

    def search_artists(self, keyword: str, limit: int = 10) -> list[QQArtistCandidate]:
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
        items = data.get("req", {}).get("data", {}).get("body", {}).get("singer", {}).get("list", []) or []
        candidates: list[QQArtistCandidate] = []
        seen: set[str] = set()
        for raw in items:
            singer = raw.get("singer", raw)
            mid = str(singer.get("singerMID") or singer.get("mid") or singer.get("singer_mid") or "").strip()
            numeric_id = str(singer.get("singerID") or singer.get("id") or singer.get("singer_id") or "").strip()
            name = html.unescape(str(singer.get("singerName") or singer.get("name") or singer.get("singer_name") or "")).strip()
            stable_key = mid or numeric_id
            if not stable_key or not name or stable_key in seen:
                continue
            seen.add(stable_key)
            candidates.append(QQArtistCandidate(
                artist_id=numeric_id,
                mid=mid,
                name=re.sub(r"<[^>]+>", "", name),
                song_count=int(singer.get("songNum") or singer.get("song_num") or 0),
                album_count=int(singer.get("albumNum") or singer.get("album_num") or 0),
            ))
        return candidates[:limit]

    def get_artist_tracks(self, singer_mid: str, limit: int = 100) -> list[str]:
        page_size = max(1, min(limit, 300))
        payload = {
            "comm": {"ct": 24, "cv": 0},
            "singerSongList": {
                "module": "musichall.song_list_server",
                "method": "GetSingerSongList",
                "param": {"order": 1, "singerMid": singer_mid, "begin": 0, "num": page_size},
            },
        }
        data = self._post_musicu(payload)
        block = data.get("singerSongList", {})
        code = block.get("code", 0)
        if code not in (0, None):
            raise QQMusicError(f"QQ Music singer-track request failed with code {code}")
        rows = block.get("data", {}).get("songList", []) or []
        return self._extract_track_titles(rows)

    def get_artist_albums(self, singer_mid: str, limit: int = 500) -> list[QQAlbum]:
        albums: list[QQAlbum] = []
        seen: set[str] = set()
        begin = 0
        page_size = min(80, max(1, limit))

        while len(albums) < limit:
            response = self.session.get(
                LEGACY_SINGER_ALBUM_URL,
                params={"singermid": singer_mid, "order": "time", "begin": begin, "num": page_size, "format": "json"},
                timeout=self.timeout,
            )
            response.raise_for_status()
            try:
                payload = response.json()
            except ValueError as exc:
                raise QQMusicError("QQ Music singer-album endpoint returned non-JSON") from exc

            rows = (payload.get("data", {}) or {}).get("list", []) or []
            if not rows:
                break
            for raw in rows:
                album_mid = str(raw.get("album_mid") or raw.get("albumMID") or raw.get("mid") or "").strip()
                album_id = str(raw.get("album_id") or raw.get("albumID") or raw.get("id") or "").strip()
                title = html.unescape(str(raw.get("album_name") or raw.get("albumName") or raw.get("name") or "")).strip()
                artist_name = html.unescape(str(raw.get("singer_name") or raw.get("singerName") or raw.get("artist_name") or "")).strip()
                publish_date = str(raw.get("pub_time") or raw.get("publish_date") or raw.get("publishDate") or "").strip()
                track_count = int(raw.get("total") or raw.get("song_count") or raw.get("songCount") or 0)
                stable_key = album_mid or album_id
                if not stable_key or not title or stable_key in seen:
                    continue
                seen.add(stable_key)

                if not publish_date and album_mid:
                    try:
                        publish_date = self.get_album_publish_date(album_mid)
                    except (QQMusicError, requests.RequestException, ValueError):
                        publish_date = ""

                albums.append(QQAlbum(
                    album_id=album_id,
                    mid=album_mid,
                    title=title,
                    artist_name=artist_name,
                    artist_mid=singer_mid,
                    publish_date=publish_date,
                    track_count=track_count,
                    cover_url=f"https://y.qq.com/music/photo_new/T002R800x800M000{album_mid}.jpg" if album_mid else "",
                ))
                if len(albums) >= limit:
                    break
            begin += len(rows)
            if len(rows) < page_size:
                break
        return albums

    @staticmethod
    def _extract_track_titles(rows: list[Any]) -> list[str]:
        titles: list[str] = []
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            song = row.get("songInfo") or row.get("songinfo") or row.get("musicData") or row.get("data") or row
            if not isinstance(song, dict):
                continue
            title = str(
                song.get("title")
                or song.get("songname")
                or song.get("songName")
                or song.get("name")
                or ""
            ).strip()
            if title:
                titles.append(title)
        return titles

    @staticmethod
    def _extract_tracks_detailed(rows: list[Any]) -> list["QQTrack"]:
        # Same shape-sniffing as _extract_track_titles, but also pulls the song's duration.
        # QQ Music's songInfo objects carry it as "interval", in whole seconds (confirmed against
        # a live GetAlbumSongList response — e.g. {"interval": 178, ...}); NetEase's own track
        # duration fields are milliseconds, so this converts at the point of extraction to keep
        # every downstream comparison in one unit.
        tracks: list[QQTrack] = []
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            song = row.get("songInfo") or row.get("songinfo") or row.get("musicData") or row.get("data") or row
            if not isinstance(song, dict):
                continue
            title = str(
                song.get("title")
                or song.get("songname")
                or song.get("songName")
                or song.get("name")
                or ""
            ).strip()
            if not title:
                continue
            interval = song.get("interval")
            try:
                duration_ms = int(float(interval)) * 1000 if interval else 0
            except (TypeError, ValueError):
                duration_ms = 0
            tracks.append(QQTrack(title=title, duration_ms=duration_ms))
        return tracks

    def _get_album_tracks_musicu_detailed(self, album_mid: str, limit: int) -> list["QQTrack"]:
        payload = {
            "comm": {"ct": 24, "cv": 0},
            "albumSongList": {
                "module": "music.musichallAlbum.AlbumSongList",
                "method": "GetAlbumSongList",
                "param": {"albumMid": album_mid, "begin": 0, "num": max(1, min(limit, 500)), "order": 2},
            },
        }
        data = self._post_musicu(payload)
        block = data.get("albumSongList", {}) or {}
        code = block.get("code", 0)
        if code not in (0, None):
            return []
        body = block.get("data", {}) or {}
        for key in ("songList", "list", "songs"):
            tracks = self._extract_tracks_detailed(body.get(key, []) or [])
            if tracks:
                return tracks
        return []

    def _get_album_tracks_legacy_detailed(self, album_mid: str, limit: int) -> list["QQTrack"]:
        payload = self._get_legacy_album_payload(album_mid)
        data = payload.get("data", {}) or {}
        for key in ("list", "songlist", "songList", "songs"):
            tracks = self._extract_tracks_detailed(data.get(key, []) or [])
            if tracks:
                return tracks[:limit]
        return []

    def get_album_tracks_detailed(self, album_mid: str, limit: int = 500) -> list["QQTrack"]:
        """Fetch QQ album tracks with title + duration, with a legacy endpoint fallback.

        Same two-tier fetch strategy as get_album_tracks (title-only), kept as a separate
        method so existing callers that only need titles are unaffected.
        """
        if not album_mid:
            return []
        try:
            tracks = self._get_album_tracks_musicu_detailed(album_mid, limit)
            if tracks:
                return tracks
        except (QQMusicError, requests.RequestException, ValueError):
            pass
        return self._get_album_tracks_legacy_detailed(album_mid, limit)

    def get_album_publish_date(self, album_mid: str) -> str:
        """Fetch an album's release date from the album-detail payload."""
        if not album_mid:
            return ""
        payload = self._get_legacy_album_payload(album_mid)
        return self._find_publish_date(payload)

    def _get_album_tracks_musicu(self, album_mid: str, limit: int) -> list[str]:
        payload = {
            "comm": {"ct": 24, "cv": 0},
            "albumSongList": {
                "module": "music.musichallAlbum.AlbumSongList",
                "method": "GetAlbumSongList",
                "param": {"albumMid": album_mid, "begin": 0, "num": max(1, min(limit, 500)), "order": 2},
            },
        }
        data = self._post_musicu(payload)
        block = data.get("albumSongList", {}) or {}
        code = block.get("code", 0)
        if code not in (0, None):
            return []
        body = block.get("data", {}) or {}
        for key in ("songList", "list", "songs"):
            titles = self._extract_track_titles(body.get(key, []) or [])
            if titles:
                return titles
        return []

    def _get_album_tracks_legacy(self, album_mid: str, limit: int) -> list[str]:
        payload = self._get_legacy_album_payload(album_mid)
        data = payload.get("data", {}) or {}
        for key in ("list", "songlist", "songList", "songs"):
            titles = self._extract_track_titles(data.get(key, []) or [])
            if titles:
                return titles[:limit]
        return []

    def get_album_tracks(self, album_mid: str, limit: int = 500) -> list[str]:
        """Fetch QQ album track titles, with a legacy endpoint fallback."""
        if not album_mid:
            return []
        try:
            titles = self._get_album_tracks_musicu(album_mid, limit)
            if titles:
                return titles
        except (QQMusicError, requests.RequestException, ValueError):
            pass
        return self._get_album_tracks_legacy(album_mid, limit)
