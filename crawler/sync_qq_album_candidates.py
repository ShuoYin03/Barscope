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


def invoke_cloud_fn(token: str, env: str, name: str, body: dict, max_retries: int = 4) -> dict:
    # Transient network blips (connect timeouts, DNS hiccups) shouldn't kill a run that's
    # hundreds of batches in — retry with exponential backoff before giving up.
    backoff = 2.0
    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
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
        except (requests.exceptions.RequestException, RuntimeError) as exc:
            last_exc = exc
            if attempt >= max_retries:
                break
            print(f"  [!] 调用失败（第 {attempt + 1}/{max_retries} 次重试前）: {exc}")
            time.sleep(backoff)
            backoff *= 2
    raise last_exc  # type: ignore[misc]


def upload_candidates(
    candidates: list[dict], token: str, env: str, batch_size: int = 20, dry_run: bool = False
) -> tuple[Counter, list[dict], list[dict]]:
    totals: Counter = Counter()
    samples: list[dict] = []
    inserted_items: list[dict] = []
    failed_items: list[dict] = []
    batches = [candidates[i:i + batch_size] for i in range(0, len(candidates), batch_size)]
    verb = "预览" if dry_run else "upload"
    for index, batch in enumerate(batches, start=1):
        try:
            result = invoke_cloud_fn(token, env, "manageAlbumCandidates", {"action": "upsert", "candidates": batch, "dryRun": dry_run})
        except Exception as exc:  # noqa: BLE001 - one permanently-failing batch must not lose all prior progress
            print(f"  {verb} [{index}/{len(batches)}] 彻底失败，跳过这批（{len(batch)}条），保留其余批次的结果: {exc}")
            failed_items.extend(batch)
            continue
        totals.update({
            "inserted": int(result.get("inserted", 0)),
            "skipped": int(result.get("skipped", 0)),
            "matchedExisting": int(result.get("matchedExisting", 0)),
            "errors": int(result.get("errors", 0)),
        })
        samples.extend(result.get("matchedExistingSamples", []) or [])
        by_key = {str(item.get("sourceKey") or ""): item for item in batch}
        for key in result.get("insertedKeys", []) or []:
            item = by_key.get(str(key))
            if item:
                inserted_items.append(item)
        print(
            f"  {verb} [{index}/{len(batches)}] "
            f"待审核 +{result.get('inserted', 0)}  "
            f"已绑定现有 {result.get('matchedExisting', 0)}  "
            f"跳过 {result.get('skipped', 0)}  错误 {result.get('errors', 0)}"
        )
    if dry_run and samples:
        print("\n服务端判定为「已存在，会绑定不新建」的样例（最多显示30条）：")
        for s in samples[:30]:
            print(f"  QQ「{s.get('title')}」({s.get('artist')})  ==  已有专辑「{s.get('existingTitle')}」[{s.get('existingAlbumId')}]")
    return totals, inserted_items, failed_items


def main() -> None:
    parser = argparse.ArgumentParser(description="同步 QQ 独有专辑到 BarScope 专辑待审核")
    parser.add_argument("--matches", action="append", help="QQ artist match JSON，可重复传入多批文件")
    parser.add_argument("--from-candidates", help="跳过重新爬QQ音乐，直接从之前 --output 生成的候选文件读取（比如重跑上传/预览步骤时）")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--new-candidates-output", default=str(BASE_DIR / "qq_album_would_be_new.json"), help="判定为待审核/新增的候选写入路径，供 verify_qq_new_candidates_by_tracks.py 做曲目复核")
    parser.add_argument("--dry-run", action="store_true", help="只跑本地质量筛选规则，不联网核对是否与库内专辑重复")
    parser.add_argument("--preview", action="store_true", help="联网跑真实的去重判定（跟正式上传一样），但不写入任何数据")
    parser.add_argument("--artist-limit", type=int, default=0, help="仅测试前 N 个 matched 艺人；0=全部")
    parser.add_argument("--sleep", type=float, default=0.2)
    parser.add_argument("--batch-size", type=int, default=20, help="每次云函数调用处理多少条候选；调小可以缓解云函数超时")
    parser.add_argument("--debug-filter-limit", type=int, default=12, help="最多打印 N 条被过滤专辑样本")
    args = parser.parse_args()

    if args.from_candidates:
        stats: Counter = Counter()
        payload = json.loads(Path(args.from_candidates).read_text(encoding="utf-8"))
        deduped = payload.get("results", []) or []
        print(f"跳过爬取，直接从 {args.from_candidates} 读取了 {len(deduped)} 条候选")
        _do_upload(args, deduped, stats)
        return

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

    _do_upload(args, deduped, stats)


def _do_upload(args: argparse.Namespace, deduped: list[dict], stats: Counter) -> None:
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
    upload_stats, inserted_items, failed_items = upload_candidates(deduped, token, env, batch_size=max(1, args.batch_size), dry_run=args.preview)
    print(f"\nCrawler stats: {dict(stats)}")
    print(f"Cloud result: {dict(upload_stats)}")

    new_candidates_path = Path(args.new_candidates_output)
    new_candidates_path.write_text(
        json.dumps({"schemaVersion": 1, "source": "qq_album_candidate_sync_inserted", "count": len(inserted_items), "results": inserted_items}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"\n判定为「待审核/新增」的候选（{len(inserted_items)} 条）已写入 -> {new_candidates_path}")
    print("标题匹配可能漏判 QQ 独家专辑的重复（标题/脏标不一样），建议再跑一遍曲目复核：")
    print(f"  python3 verify_qq_new_candidates_by_tracks.py --new-candidates {new_candidates_path}")

    if failed_items:
        failed_path = Path(args.output).with_name(Path(args.output).stem + "_failed_batches.json")
        failed_path.write_text(
            json.dumps({"schemaVersion": 1, "count": len(failed_items), "results": failed_items}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"\n[!] 有 {len(failed_items)} 条因为网络问题彻底失败，没有处理，已保存到 -> {failed_path}")
        print("  建议网络恢复后原样重跑一次本命令；已经成功处理过的候选，服务端会按 sourceKey 自动识别跳过，不会重复。")

    if args.preview:
        print("\n预览完成：以上是真实的去重判定结果，没有写入任何数据。确认没问题后去掉 --preview 正式跑。")
    else:
        print("\n完成：真正缺失的 QQ 专辑已进入 专辑管理 → 待审核；已存在专辑只补充 QQ identity。")


if __name__ == "__main__":
    main()
