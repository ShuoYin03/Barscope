#!/usr/bin/env python3
"""Fast concurrent QQ album candidate sync.

Uses the same candidate rules and cloud-side dedupe as sync_qq_album_candidates.py,
but fetches artist album catalogues and album tracklists concurrently.
"""

from __future__ import annotations

import argparse
import json
import threading
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

from qqmusic_client import QQMusicClient, QQMusicError
from sync_qq_album_candidates import (
    CONFIG_FILE,
    DEFAULT_MATCHES,
    DEFAULT_OUTPUT,
    build_candidate,
    get_access_token,
    load_rows,
    upload_candidates,
)

_thread_local = threading.local()


def get_client() -> QQMusicClient:
    client = getattr(_thread_local, "qq_client", None)
    if client is None:
        client = QQMusicClient()
        _thread_local.qq_client = client
    return client


def fetch_catalog(index: int, row: dict) -> tuple[int, dict, list, str | None]:
    best = row.get("bestCandidate") or {}
    qq_mid = str(best.get("mid") or "").strip()
    try:
        return index, row, get_client().get_artist_albums(qq_mid), None
    except (QQMusicError, requests.RequestException, OSError, ValueError) as exc:
        return index, row, [], str(exc)


def fetch_tracks(task_id: int, album) -> tuple[int, list[str], str | None]:
    if not album.mid:
        return task_id, [], None
    try:
        return task_id, get_client().get_album_tracks(album.mid), None
    except (QQMusicError, requests.RequestException, OSError, ValueError) as exc:
        return task_id, [], str(exc)


def main() -> None:
    parser = argparse.ArgumentParser(description="高速并发同步 QQ 独有专辑到 BarScope 专辑待审核")
    parser.add_argument("--matches", action="append", help="QQ artist match JSON，可重复传入多批文件")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--artist-limit", type=int, default=0, help="仅测试前 N 个 matched 艺人；0=全部")
    parser.add_argument("--workers", type=int, default=20, help="并发请求数，默认 20")
    parser.add_argument("--debug-filter-limit", type=int, default=12, help="最多打印 N 条被过滤专辑样本")
    args = parser.parse_args()

    match_paths = [Path(p) for p in args.matches] if args.matches else [DEFAULT_MATCHES]
    rows = load_rows(match_paths)
    if args.artist_limit > 0:
        rows = rows[:args.artist_limit]

    workers = max(1, min(args.workers, 40))
    print(f"Matched artists: {len(rows)} | workers={workers}")

    stats: Counter = Counter()
    filter_reasons: Counter = Counter()
    candidates: list[dict] = []
    debug_printed = 0

    # Stage 1: fetch all artist album catalogues concurrently.
    catalog_results: dict[int, tuple[dict, list]] = {}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(fetch_catalog, i, row) for i, row in enumerate(rows, start=1)]
        completed = 0
        for future in as_completed(futures):
            index, row, albums, error = future.result()
            completed += 1
            artist_name = str(row.get("displayName") or (row.get("bestCandidate") or {}).get("name") or "")
            if error:
                stats["artist_errors"] += 1
                print(f"[catalog {completed}/{len(rows)}] {artist_name} [!] {error}")
            else:
                catalog_results[index] = (row, albums)
                stats["albums_seen"] += len(albums)
                if completed % 25 == 0 or len(albums) >= 20:
                    print(f"[catalog {completed}/{len(rows)}] {artist_name}: albums={len(albums)}")

    # Stage 2: flatten all albums and fetch every tracklist concurrently.
    tasks: list[tuple[int, int, dict, object]] = []
    task_id = 0
    for artist_index in sorted(catalog_results):
        row, albums = catalog_results[artist_index]
        for album in albums:
            task_id += 1
            tasks.append((task_id, artist_index, row, album))

    print(f"Fetching tracklists for {len(tasks)} albums...")
    tracks_by_task: dict[int, list[str]] = {}
    errors_by_task: dict[int, str] = {}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {executor.submit(fetch_tracks, tid, album): tid for tid, _, _, album in tasks}
        completed = 0
        for future in as_completed(future_map):
            tid, tracks, error = future.result()
            completed += 1
            tracks_by_task[tid] = tracks
            if error:
                errors_by_task[tid] = error
                stats["track_fetch_errors"] += 1
            if completed % 100 == 0 or completed == len(tasks):
                print(f"  tracklists {completed}/{len(tasks)}")

    passed_by_artist: Counter = Counter()
    album_count_by_artist: Counter = Counter()
    for tid, artist_index, row, album in tasks:
        album_count_by_artist[artist_index] += 1
        tracks = tracks_by_task.get(tid, [])
        candidate, filter_reason = build_candidate(row, album, tracks)
        if candidate:
            candidates.append(candidate)
            stats["passed_rules"] += 1
            passed_by_artist[artist_index] += 1
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

    for artist_index in sorted(catalog_results):
        row, _ = catalog_results[artist_index]
        artist_name = str(row.get("displayName") or (row.get("bestCandidate") or {}).get("name") or "")
        print(
            f"[{artist_index}/{len(rows)}] {artist_name} "
            f"albums={album_count_by_artist[artist_index]} passed={passed_by_artist[artist_index]}"
        )

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
        json.dumps(
            {"schemaVersion": 1, "source": "qq_album_candidate_sync", "count": len(deduped), "results": deduped},
            ensure_ascii=False,
            indent=2,
        ) + "\n",
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
