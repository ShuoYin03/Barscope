#!/usr/bin/env python3
"""Re-check "new" QQ album candidates by actual track overlap, not just title matching.

dedupe_qq_album_candidates.py's title-based pass is a cheap first filter, but two things
make it produce false "new" results:
  1. A candidate with no resolved barscopeArtistId/neteaseArtistId never enters the
     same-artist comparison pool at all, so it can never match anything by title —
     "new" here just means "we don't know who this is", not "we don't have it".
  2. QQ track/album titles are often dirty ("(Live)", "(伴奏)", "【独家】"...), which can
     make a genuinely-owned album's title fail to match its NetEase counterpart.

This script re-checks each "new" candidate against its same-artist pool using actual
track title (dirty-tag-stripped) + duration overlap — pulling the QQ tracklist live (only
for this already-filtered, much smaller set, not the full candidate list) and comparing
against each pool album's *already-synced* `tracks` field (no NetEase calls needed; a pool
album that has never been opened in the app has no track data yet and is reported as
unverifiable rather than silently counted either way).

Usage:
  python3 verify_qq_new_candidates_by_tracks.py \
      --new-candidates qq_album_dedupe_new_candidates.json \
      --config config.json \
      --output-dir .
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

from dedupe_qq_album_candidates import (
    candidate_artist_ids,
    clean,
    database_query,
    db_artist_ids,
    get_access_token,
    load_json,
    summarize_album,
    write_json,
)
from qqmusic_client import QQMusicClient, QQMusicError
from track_match import overlap_ratio

CONFIRMED_DUPLICATE_THRESHOLD = 0.6


def fetch_all_albums(token: str, env: str, page_size: int = 100) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    offset = 0
    while True:
        query = f'db.collection("albums").skip({offset}).limit({page_size}).get()'
        data = database_query(token, env, query)
        raw_rows = data.get("data") or []
        batch: List[Dict[str, Any]] = []
        for raw in raw_rows:
            if isinstance(raw, str):
                import json
                try:
                    row = json.loads(raw)
                except json.JSONDecodeError:
                    continue
            elif isinstance(raw, dict):
                row = raw
            else:
                continue
            batch.append(row)
        rows.extend(batch)
        print(f"  已读取数据库专辑: {len(rows)}", flush=True)
        if len(batch) < page_size:
            break
        offset += page_size
        time.sleep(0.05)
    return rows


def build_artist_index(albums: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    index: Dict[str, List[Dict[str, Any]]] = {}
    for album in albums:
        for artist_id in db_artist_ids(album):
            index.setdefault(artist_id, []).append(album)
    return index


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify QQ 'new' album candidates by track overlap")
    parser.add_argument("--new-candidates", default="qq_album_dedupe_new_candidates.json")
    parser.add_argument("--config", default="config.json")
    parser.add_argument("--output-dir", default=".")
    parser.add_argument("--overlap-threshold", type=float, default=CONFIRMED_DUPLICATE_THRESHOLD)
    parser.add_argument("--sleep", type=float, default=0.3, help="seconds between QQ track-fetch calls")
    args = parser.parse_args()

    new_path = Path(args.new_candidates).expanduser().resolve()
    config_path = Path(args.config).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()

    if not new_path.exists():
        print(f"找不到候选文件: {new_path}", file=sys.stderr)
        return 2
    if not config_path.exists():
        print(f"找不到配置文件: {config_path}", file=sys.stderr)
        return 2

    payload = load_json(new_path)
    candidates = payload.get("results", payload) if isinstance(payload, dict) else payload
    if not isinstance(candidates, list):
        print("候选 JSON 格式不正确", file=sys.stderr)
        return 2

    config = load_json(config_path)
    appid, appsecret, env = clean(config.get("appid")), clean(config.get("appsecret")), clean(config.get("env"))
    if not appid or not appsecret or not env or appid.startswith("<"):
        print("config.json 缺少真实的 appid / appsecret / env", file=sys.stderr)
        return 2

    print(f"待复核候选数量: {len(candidates)}")
    print("正在拉取 BarScope albums 数据库（用于建立同艺人曲目池）……")
    token = get_access_token(appid, appsecret)
    albums = fetch_all_albums(token, env)
    print(f"数据库专辑数量: {len(albums)}")
    artist_index = build_artist_index(albums)

    qq = QQMusicClient()

    confirmed_new: List[Dict[str, Any]] = []
    confirmed_duplicate: List[Dict[str, Any]] = []
    no_artist_link: List[Dict[str, Any]] = []
    unverified: List[Dict[str, Any]] = []

    for idx, item in enumerate(candidates, 1):
        title = item.get("title") or ""
        artist_ids = candidate_artist_ids(item)
        qq_mid = clean(item.get("qqAlbumMid"))
        print(f"[{idx}/{len(candidates)}] {title}", flush=True)

        if not artist_ids:
            no_artist_link.append(item)
            continue

        pool: List[Dict[str, Any]] = []
        seen = set()
        for aid in artist_ids:
            for album in artist_index.get(aid, []):
                key = clean(album.get("_id")) or repr(album)
                if key not in seen:
                    seen.add(key)
                    pool.append(album)

        if not pool:
            confirmed_new.append(item)
            continue

        if not qq_mid:
            unverified.append({**item, "verifyNote": "候选缺少 qqAlbumMid，无法拉取曲目"})
            continue

        try:
            qq_tracks = qq.get_album_tracks_detailed(qq_mid)
        except (QQMusicError, Exception) as exc:  # noqa: BLE001 - best-effort diagnostic script
            unverified.append({**item, "verifyNote": f"拉取 QQ 曲目失败: {exc}"})
            time.sleep(args.sleep)
            continue

        if not qq_tracks:
            unverified.append({**item, "verifyNote": "QQ 曲目列表为空"})
            time.sleep(args.sleep)
            continue

        best_ratio = 0.0
        best_album = None
        any_synced = False
        for album in pool:
            ne_tracks = album.get("tracks") or []
            if not ne_tracks:
                continue
            any_synced = True
            ratio = overlap_ratio(qq_tracks, ne_tracks)
            if ratio > best_ratio:
                best_ratio = ratio
                best_album = album

        if not any_synced:
            unverified.append({**item, "verifyNote": f"同艺人在库的 {len(pool)} 张专辑都还没同步过曲目数据，无法比对"})
        elif best_ratio >= args.overlap_threshold:
            confirmed_duplicate.append({
                "candidate": item,
                "matchedAlbum": summarize_album(best_album),
                "overlapRatio": round(best_ratio, 4),
            })
        else:
            confirmed_new.append({**item, "bestOverlapRatio": round(best_ratio, 4)})

        time.sleep(args.sleep)

        if idx % 20 == 0 or idx == len(candidates):
            print(
                f"  进度 {idx}/{len(candidates)} | 确认新增 {len(confirmed_new)} | "
                f"确认重复 {len(confirmed_duplicate)} | 无艺人关联 {len(no_artist_link)} | 无法核实 {len(unverified)}",
                flush=True,
            )

    write_json(output_dir / "qq_album_verify_confirmed_new.json", {"count": len(confirmed_new), "results": confirmed_new})
    write_json(output_dir / "qq_album_verify_confirmed_duplicate.json", {"count": len(confirmed_duplicate), "results": confirmed_duplicate})
    write_json(output_dir / "qq_album_verify_no_artist_link.json", {"count": len(no_artist_link), "results": no_artist_link})
    write_json(output_dir / "qq_album_verify_unverified.json", {"count": len(unverified), "results": unverified})

    summary = {
        "inputNewCandidates": len(candidates),
        "confirmedNew": len(confirmed_new),
        "confirmedDuplicate": len(confirmed_duplicate),
        "noArtistLink": len(no_artist_link),
        "unverified": len(unverified),
        "overlapThreshold": args.overlap_threshold,
    }
    write_json(output_dir / "qq_album_verify_summary.json", summary)

    print("\n=== 曲目复核完成 ===")
    for key, value in summary.items():
        print(f"  {key}: {value}")
    print("\nconfirmedNew = 真正很可能是 QQ 音乐独家的专辑（下一步应该重点看这个文件）")
    print("noArtistLink = 候选没有解析出艺人身份，不是标题不匹配——先去修艺人识别那一步")
    print("unverified = 同艺人在库专辑还没同步过曲目，没法比对，不代表缺失也不代表重复")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
