#!/usr/bin/env python3
"""Discover QQ Music-only albums and send them to the existing Album Review queue.

Flow:
1. Read resolved NetEase ↔ QQ artist mappings.
2. Fetch QQ album catalogues for matched artists.
3. Apply the same basic collection rules used by the NetEase crawler, except QQ release dates are optional.
4. Upload candidates to manageAlbumCandidates.
5. Cloud-side dedupe binds matching QQ identities onto existing BarScope albums;
   only genuinely missing albums enter album_candidates as pending.

Usage:
  python3 sync_qq_album_candidates.py --dry-run
  python3 sync_qq_album_candidates.py
  python3 sync_qq_album_candidates.py --matches batch1.json --matches batch2.json
"""

from __future__ import annotations

import argparse
import json
import re
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

import requests

from qqmusic_client import QQMusicClient, QQMusicError


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_MATCHES = BASE_DIR / "qq_artist_matches.json"
DEFAULT_OUTPUT = BASE_DIR / "qq_album_candidates.json"
CONFIG_FILE = BASE_DIR / "config.json"
CURRENT_YEAR = datetime.now().year

SKIP_KEYWORDS = [
    "第一期", "第二期", "第三期", "第四期", "第五期",
    "第六期", "第七期", "第八期", "第九期", "第十期",
    "精选集", "合辑", "现场版", "Live", "OST", "原声",
    "巅峰对决", "新说唱", "中国有嘻哈", "说唱新世代",
]

VERSION_SUFFIX = re.compile(
    r"\s*(?:[\(\[（【].*?[\)\]）】]|[-–—:]\s*(?:伴奏|伴奏版|纯音乐|inst(?:rumental)?|instrumental|demo|remix|acapella|karaoke|beat|off\s*vocal|vocal\s*less).*)$",
    re.IGNORECASE,
)
EXTRA_VERSION_WORDS = re.compile(
    r"\b(?:伴奏版?|纯音乐|inst(?:rumental)?|instrumental|demo|remix|acapella|karaoke|beat|off\s*vocal|vocal\s*less)\b",
    re.IGNORECASE,
)


def normalize_title(value: str) -> str:
    value = (value or "").strip().lower()
    return re.sub(r"[\s\-_·•:：()（）\[\]【】'\"“”‘’]+", "", value)


def normalize_track_title(title: str) -> str:
    value = (title or "").strip().lower()
    value = VERSION_SUFFIX.sub("", value)
    value = EXTRA_VERSION_WORDS.sub("", value)
    value = re.sub(r"[\s\-_·•:：()（）\[\]【】]+", "", value)
    return value


def repeated_track_metadata(titles: list[str]) -> dict[str, Any]:
    groups: dict[str, list[str]] = {}
    for title in titles:
        key = normalize_track_title(title)
        if key:
            groups.setdefault(key, []).append(title)
    duplicated = [values for values in groups.values() if len(values) >= 3]
    if not duplicated:
        return {}
    return {
        "requiresManualReview": True,
        "duplicateTrackGroups": duplicated,
        "duplicateTrackExample": duplicated[0],
    }


def parse_year(value: str) -> int:
    match = re.search(r"(?:19|20)\d{2}", value or "")
    return int(match.group(0)) if match else 0


def load_rows(paths: list[Path]) -> list[dict]:
    rows: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for row in payload.get("results", []) or []:
            if row.get("resolutionStatus") != "matched":
                continue
            best = row.get("bestCandidate") or {}
            qq_mid = str(best.get("mid") or "").strip()
            netease_id = str(row.get("neteaseArtistId") or "").strip()
            if not qq_mid or not netease_id:
                continue
            key = (netease_id, qq_mid)
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
    return rows


def build_candidate(row: dict, album: Any, tracks: list[str]) -> tuple[dict[str, Any] | None, str]:
    title = str(album.title or "").strip()
    artist = str(row.get("displayName") or album.artist_name or "").strip()
    year = parse_year(album.publish_date)
    track_count = int(album.track_count or len(tracks) or 0)

    if not title:
        return None, "missing_title"
    if not artist:
        return None, "missing_artist"
    if not album.cover_url:
        return None, "missing_cover"
    # QQ's current album endpoints often omit release dates entirely. Missing dates
    # must not block discovery; only reject a year when QQ actually supplied one
    # and it is clearly outside the accepted range.
    if year and (year < 1990 or year > CURRENT_YEAR):
        return None, "invalid_year"
    if track_count < 3:
        return None, "track_count_lt_3"
    if any(keyword.lower() in title.lower() for keyword in SKIP_KEYWORDS):
        return None, "skip_keyword"

    repeat_meta = repeated_track_metadata(tracks)
    reason = "QQ音乐发现 · 网易云/BarScope现有专辑库未匹配 · 符合当前专辑收录规则"
    if not year:
        reason += "；QQ未提供发行日期，待审核时补充"
    if repeat_meta:
        reason += "；同一专辑存在3首及以上同名/版本曲目，需人工确认"

    source_id = str(album.mid or album.album_id).strip()
    return {
        "title": title,
        "normalizedTitle": normalize_title(title),
        "artist": artist,
        "primaryArtist": artist,
        "neteaseArtistId": str(row.get("neteaseArtistId") or ""),
        "barscopeArtistId": row.get("barscopeArtistId"),
        "artistIds": [str(row.get("neteaseArtistId"))] if row.get("neteaseArtistId") else [],
        "releaseDate": album.publish_date,
        "releaseYear": year,
        "coverUrl": album.cover_url,
        "genres": [],
        "sourceId": source_id,
        "source": "qq",
        "sourcePlatform": "qq",
        "sourceKey": f"qq:{source_id}",
        "qqAlbumMid": str(album.mid or ""),
        "qqAlbumId": str(album.album_id or ""),
        "qqArtistMid": str(album.artist_mid or ""),
        "submissionMode": "qq",
        "candidateReason": reason,
        "avgScore": 0,
        "reviewCount": 0,
        "trackCount": track_count,
        "tracks": [{"no": i + 1, "name": name} for i, name in enumerate(tracks)],
        **repeat_meta,
    }, "passed"


def get_access_token(appid: str, appsecret: str) -> str:
    response = requests.get(
        "https://api.weixin.qq.com/cgi-bin/token",
        params={"grant_type": "client_credential", "appid": appid, "secret": appsecret},
        timeout=15,
    )
    response.raise_for_status()
    payload = response.json()
    token = payload.get("access_token")
    if not token:
        raise RuntimeError(f"获取 access_token 失败: {payload}")
    return str(token)


def invoke_cloud_fn(token: str, env: str, name: str, body: dict) -> dict:
    response = requests.post(
        "https://api.weixin.qq.com/tcb/invokecloudfunction",
        params={"access_token": token, "env": env, "name": name},
        json=body,
        timeout=90,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("errcode", 0) != 0:
        raise RuntimeError(f"云函数调用失败: {payload}")
    return json.loads(payload.get("resp_data", "{}"))


def upload_candidates(candidates: list[dict], token: str, env: str, batch_size: int = 20) -> Counter:
    totals: Counter = Counter()
    batches = [candidates[i:i + batch_size] for i in range(0, len(candidates), batch_size)]
    for index, batch in enumerate(batches, start=1):
        result = invoke_cloud_fn(token, env, "manageAlbumCandidates", {"action": "upsert", "candidates": batch})
        totals.update({
            "inserted": int(result.get("inserted", 0)),
            "skipped": int(result.get("skipped", 0)),
            "matchedExisting": int(result.get("matchedExisting", 0)),
            "errors": int(result.get("errors", 0)),
        })
        print(
            f"  upload [{index}/{len(batches)}] "
            f"待审核 +{result.get('inserted', 0)}  "
            f"已绑定现有 {result.get('matchedExisting', 0)}  "
            f"跳过 {result.get('skipped', 0)}  错误 {result.get('errors', 0)}"
        )
    return totals


def main() -> None:
    parser = argparse.ArgumentParser(description="同步 QQ 独有专辑到 BarScope 专辑待审核")
    parser.add_argument("--matches", action="append", help="QQ artist match JSON，可重复传入多批文件")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--artist-limit", type=int, default=0, help="仅测试前 N 个 matched 艺人；0=全部")
    parser.add_argument("--sleep", type=float, default=0.2)
    parser.add_argument("--debug-filter-limit", type=int, default=12, help="最多打印 N 条被过滤专辑样本")
    args = parser.parse_args()

    match_paths = [Path(p) for p in args.matches] if args.matches else [DEFAULT_MATCHES]
    rows = load_rows(match_paths)
    if args.artist_limit > 0:
        rows = rows[:args.artist_limit]

    print(f"Matched artists: {len(rows)}")
    qq = QQMusicClient()
    candidates: list[dict] = []
    stats: Counter = Counter()
    filter_reasons: Counter = Counter()
    debug_printed = 0

    for index, row in enumerate(rows, start=1):
        best = row.get("bestCandidate") or {}
        qq_mid = str(best.get("mid") or "").strip()
        artist_name = str(row.get("displayName") or best.get("name") or "")
        print(f"[{index}/{len(rows)}] {artist_name}")
        try:
            albums = qq.get_artist_albums(qq_mid)
        except (QQMusicError, requests.RequestException, OSError, ValueError) as exc:
            stats["artist_errors"] += 1
            print(f"  [!] album catalogue failed: {exc}")
            continue

        stats["albums_seen"] += len(albums)
        artist_passed = 0
        for album in albums:
            try:
                tracks = qq.get_album_tracks(album.mid) if album.mid else []
            except (QQMusicError, requests.RequestException, OSError, ValueError) as exc:
                tracks = []
                stats["track_fetch_errors"] += 1
                if debug_printed < args.debug_filter_limit:
                    print(f"  [!] track fetch failed {album.title}: {exc}")

            candidate, filter_reason = build_candidate(row, album, tracks)
            if candidate:
                candidates.append(candidate)
                stats["passed_rules"] += 1
                artist_passed += 1
            else:
                stats["filtered"] += 1
                filter_reasons[filter_reason] += 1
                if debug_printed < args.debug_filter_limit:
                    print(
                        "  FILTER "
                        f"[{filter_reason}] {album.title!r} | "
                        f"date={album.publish_date!r} | "
                        f"listCount={album.track_count} | fetchedTracks={len(tracks)} | "
                        f"mid={album.mid!r}"
                    )
                    debug_printed += 1

            if args.sleep > 0:
                time.sleep(args.sleep)

        print(f"  albums={len(albums)} passed={artist_passed}")

    deduped: list[dict] = []
    seen_keys: set[str] = set()
    for item in candidates:
        key = str(item.get("sourceKey") or "")
        if not key or key in seen_keys:
            continue
        seen_keys.add(key)
        deduped.append(item)

    output = Path(args.output)
    output.write_text(
        json.dumps({"schemaVersion": 1, "source": "qq_album_candidate_sync", "count": len(deduped), "results": deduped}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"\nRule-passed QQ albums: {len(deduped)} -> {output}")
    print(f"Filter reasons: {dict(filter_reasons)}")

    if args.dry_run:
        print(f"Dry run complete: {dict(stats)}")
        return

    if not CONFIG_FILE.exists():
        raise SystemExit(f"找不到 {CONFIG_FILE}")
    config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    appid = str(config.get("appid") or "")
    appsecret = str(config.get("appsecret") or "")
    env = str(config.get("env") or "")
    if not appid or not appsecret or not env:
        raise SystemExit("config.json 缺少 appid / appsecret / env")

    token = get_access_token(appid, appsecret)
    upload_stats = upload_candidates(deduped, token, env)
    print(f"\nCrawler stats: {dict(stats)}")
    print(f"Cloud result: {dict(upload_stats)}")
    print("完成：真正缺失的 QQ 专辑已进入 专辑管理 → 待审核；已存在专辑只补充 QQ identity。")


if __name__ == "__main__":
    main()
