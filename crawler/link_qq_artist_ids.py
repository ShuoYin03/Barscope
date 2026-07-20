#!/usr/bin/env python3
"""Persist confirmed NetEase<->QQ artist identity links into the artists collection.

resolve_qq_artist_candidates.py already does the real work (disambiguating a QQ artist
account against a NetEase one by actual track-catalogue overlap, never a name guess) and
writes its output to qq_artist_matches.json. That file only lives on this machine though,
so every future QQ scan re-derives the same links from scratch. This script pushes the
"matched" rows into the artists collection (keyed by neteaseArtistId, same collection
syncApprovedArtist already upserts avatar/hero data into) so future scans can skip
straight to fetching a linked artist's QQ discography instead of re-searching+re-resolving.

Usage:
  python3 link_qq_artist_ids.py --matches qq_artist_matches.json
  python3 link_qq_artist_ids.py --matches qq_artist_matches.json --dry-run
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from sync_qq_album_candidates import CONFIG_FILE, get_access_token, invoke_cloud_fn

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_MATCHES = BASE_DIR / "qq_artist_matches.json"


def load_links(paths: list[Path]) -> list[dict]:
    links: list[dict] = []
    seen: set[str] = set()
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for row in payload.get("results", []) or []:
            if row.get("resolutionStatus") != "matched":
                continue
            best = row.get("bestCandidate") or {}
            netease_id = str(row.get("neteaseArtistId") or "").strip()
            qq_mid = str(best.get("mid") or "").strip()
            if not netease_id or not qq_mid or netease_id in seen:
                continue
            seen.add(netease_id)
            links.append({
                "neteaseArtistId": netease_id,
                "qqArtistMid": qq_mid,
                "qqArtistId": str(best.get("artist_id") or ""),
                "qqArtistName": str(best.get("name") or row.get("displayName") or ""),
            })
    return links


def main() -> None:
    parser = argparse.ArgumentParser(description="把已确认的 QQ<->网易云艺人关联写入数据库")
    parser.add_argument("--matches", action="append", help="resolve_qq_artist_candidates.py 的输出，可重复传入多批文件")
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--dry-run", action="store_true", help="只统计要写入多少条，不联网")
    args = parser.parse_args()

    match_paths = [Path(p) for p in args.matches] if args.matches else [DEFAULT_MATCHES]
    links = load_links(match_paths)
    print(f"确认关联（matched）的艺人：{len(links)} 位")

    if args.dry_run:
        for link in links[:20]:
            print(f"  {link['qqArtistName']}  netease={link['neteaseArtistId']}  qqMid={link['qqArtistMid']}")
        if len(links) > 20:
            print(f"  ...还有 {len(links) - 20} 条")
        return

    if not links:
        print("没有可写入的关联，退出。")
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
    batches = [links[i:i + args.batch_size] for i in range(0, len(links), args.batch_size)]
    updated = inserted = errors = 0
    for index, batch in enumerate(batches, start=1):
        result = invoke_cloud_fn(token, env, "manageCandidates", {"action": "link_qq_artists", "links": batch})
        updated += int(result.get("updated", 0))
        inserted += int(result.get("inserted", 0))
        errors += int(result.get("errors", 0))
        print(f"  [{index}/{len(batches)}] 更新 {result.get('updated', 0)}  新建 {result.get('inserted', 0)}  错误 {result.get('errors', 0)}")

    print(f"\n完成：更新 {updated}，新建 {inserted}，错误 {errors}，共 {len(links)} 位艺人已关联QQ音乐ID。")
    print("以后同步 QQ 独家专辑时，这些艺人不用再重新搜索匹配，可以直接用已存的 qqArtistMid。")


if __name__ == "__main__":
    main()
