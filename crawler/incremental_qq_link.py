#!/usr/bin/env python3
"""Link only newly-approved artists to QQ Music — skips everyone already linked.

Companion to crawl_qq_artist_candidates.py / resolve_qq_artist_candidates.py /
link_qq_artist_ids.py, which process the whole rappers.json every time. As the catalog
grows, re-running that full pipeline just to pick up a handful of newly-approved artists
gets slower and more wasteful for no reason — most of rappers.json is already linked. This
script asks the database who's already linked (get_qq_artist_links), filters rappers.json
down to whoever's missing, and only runs search+resolve+link for that (usually small) set.

Meant to be triggered from the CMS's Crawler Jobs page (mode "qq_link_incremental") and run
here afterward — same two-step pattern as the existing "裂变发现"/"同步决定" local modes:
tapping the button in the app just marks a job pending; nothing runs until this script is
actually executed on this machine. Reports progress back the same way pipeline.py does, so
it shows up in the same 运行状态/运行日志 cards.

Usage:
  python3 incremental_qq_link.py                  # claims a pending job from the app
  python3 incremental_qq_link.py --skip-db-check   # runs immediately, no app trigger needed
  python3 incremental_qq_link.py --skip-db-check --dry-run   # just show who's missing, do nothing else
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from crawl_qq_artist_candidates import crawl
from db_client import CrawlerDB
from link_qq_artist_ids import links_from_results, upload_links
from resolve_qq_artist_candidates import resolve_rows
from sync_qq_album_candidates import CONFIG_FILE, get_access_token, invoke_cloud_fn

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_ARTISTS = BASE_DIR / "rappers.json"


def load_artists(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload.get("rappers", [])


def get_linked_netease_ids(token: str, env: str) -> set[str]:
    result = invoke_cloud_fn(token, env, "manageCandidates", {"action": "get_qq_artist_links"})
    return {str(link.get("neteaseArtistId") or "") for link in result.get("links", []) or []}


def find_unlinked(artists: list[dict], linked: set[str]) -> list[dict]:
    unlinked = []
    for artist in artists:
        netease_id = str((artist.get("platforms") or {}).get("netease", {}).get("artistId") or "").strip()
        if netease_id and netease_id not in linked:
            unlinked.append(artist)
    return unlinked


def main() -> None:
    parser = argparse.ArgumentParser(description="只给还没关联QQ音乐ID的新艺人做关联")
    parser.add_argument("--artists", default=str(DEFAULT_ARTISTS))
    parser.add_argument("--skip-db-check", action="store_true", help="不认领云端任务，直接运行（本地测试用）")
    parser.add_argument("--dry-run", action="store_true", help="只列出还没关联的艺人，不联网搜索/写入")
    parser.add_argument("--workers", type=int, default=10)
    args = parser.parse_args()

    if not CONFIG_FILE.exists():
        print(f"[!] 找不到 {CONFIG_FILE}")
        return
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    appid, appsecret, env = cfg.get("appid", ""), cfg.get("appsecret", ""), cfg.get("env", "")
    if not appsecret or appsecret.startswith("<"):
        print("[!] 请先在 config.json 填入 appsecret")
        return

    db = CrawlerDB(cfg) if not args.dry_run else None

    if db and not args.skip_db_check:
        claimed = db.claim_run()
        if not claimed:
            print("未发现 pending 任务，退出。（如需强制运行，加 --skip-db-check）")
            return
        print(f"已认领任务（模式: {claimed.get('mode')}），开始运行。")
        db.append_log("QQ音乐增量关联开始")

    try:
        token = get_access_token(appid, appsecret)
        linked = get_linked_netease_ids(token, env)
        print(f"数据库里已经关联QQ音乐ID的艺人：{len(linked)} 位")

        artists = load_artists(Path(args.artists))
        unlinked = find_unlinked(artists, linked)
        print(f"rappers.json 里还没关联的艺人：{len(unlinked)} 位")
        if db:
            db.append_log(f"发现 {len(unlinked)} 位新艺人待关联QQ音乐ID")
            db.update_progress(total_artists=len(unlinked), processed=0)

        if not unlinked:
            print("没有需要处理的新艺人。")
            if db:
                db.append_log("没有新艺人需要关联")
                db.complete_run(new_albums=0, new_candidates=0, errors=[])
            return

        if args.dry_run:
            for artist in unlinked[:30]:
                print(f"  {artist.get('name')}  netease={(artist.get('platforms') or {}).get('netease', {}).get('artistId')}")
            if len(unlinked) > 30:
                print(f"  ...还有 {len(unlinked) - 30} 位")
            return

        print("\n━━━ 在QQ音乐搜索候选 ━━━")
        candidate_result = crawl(unlinked, limit=5, sleep_seconds=0.0, workers=args.workers)
        rows = candidate_result.get("results", [])
        if db:
            db.append_log(f"QQ音乐搜索完成，{len(rows)} 位有候选")
            db.update_progress(total_artists=len(unlinked), processed=len(unlinked) // 2)

        print("\n━━━ 用曲目重合度确认候选 ━━━")
        resolved = resolve_rows(rows, workers=args.workers)
        matched_count = sum(1 for r in resolved if r.get("resolutionStatus") == "matched")
        print(f"确认关联（matched）：{matched_count} / {len(resolved)} 位")
        if db:
            db.append_log(f"曲目比对完成，确认关联 {matched_count} 位")

        links = links_from_results(resolved)
        upload_stats = upload_links(links, token, env) if links else {"updated": 0, "inserted": 0, "errors": 0, "rejected": 0}
        print(f"写入结果：{upload_stats}")

        errors = []
        if upload_stats.get("rejected"):
            errors.append(f"{upload_stats['rejected']} 条服务端复核未通过")
        if upload_stats.get("errors"):
            errors.append(f"{upload_stats['errors']} 条写入失败")

        if db:
            db.append_log(f"关联完成：更新 {upload_stats.get('updated', 0)}，新建 {upload_stats.get('inserted', 0)}")
            db.update_progress(total_artists=len(unlinked), processed=len(unlinked))
            db.complete_run(new_albums=0, new_candidates=upload_stats.get("updated", 0) + upload_stats.get("inserted", 0), errors=errors)

        print(f"\n完成：{matched_count} 位新艺人已关联QQ音乐ID，{len(unlinked) - matched_count} 位这次没找到足够曲目证据（下次再跑会重试）。")

    except Exception as exc:  # noqa: BLE001 - single-shot CLI job, report and exit rather than crash silently
        print(f"[!] 运行失败: {exc}")
        if db:
            db.fail_run(str(exc))


if __name__ == "__main__":
    main()
