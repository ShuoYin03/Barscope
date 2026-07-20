#!/usr/bin/env python3
"""One-off probe: dump QQ Music's raw album-detail + track-list payloads.

Used to find the real field names for album description / label(company) / per-track
artist credits before writing real extraction code into qqmusic_client.py — the same
"confirm the field name against a live response before coding" step this session already
did once for track duration (turned out to be `interval`, in whole seconds).

Usage:
  python3 probe_qq_album_metadata.py <album_mid>

Find an album_mid from a recently-imported QQ album: check its `qqAlbumMid` field in the
albums collection, or re-run against qq_album_candidates.json (each entry has qqAlbumMid).
"""

from __future__ import annotations

import json
import sys

from qqmusic_client import QQMusicClient


def main() -> None:
    if len(sys.argv) < 2:
        print("用法: python3 probe_qq_album_metadata.py <album_mid>")
        return
    album_mid = sys.argv[1]
    client = QQMusicClient()

    print("━━━ 专辑详情原始payload (fcg_v8_album_info_cp.fcg) ━━━")
    detail = client._get_legacy_album_payload(album_mid)  # noqa: SLF001 - one-off probe
    print(json.dumps(detail, ensure_ascii=False, indent=2)[:6000])

    print("\n\n━━━ 曲目列表原始payload，只看第一首歌 (GetAlbumSongList) ━━━")
    payload = {
        "comm": {"ct": 24, "cv": 0},
        "albumSongList": {
            "module": "music.musichallAlbum.AlbumSongList",
            "method": "GetAlbumSongList",
            "param": {"albumMid": album_mid, "begin": 0, "num": 3, "order": 2},
        },
    }
    tracks_payload = client._post_musicu(payload)  # noqa: SLF001 - one-off probe
    print(json.dumps(tracks_payload, ensure_ascii=False, indent=2)[:6000])


if __name__ == "__main__":
    main()
