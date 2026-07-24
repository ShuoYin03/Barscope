#!/usr/bin/env python3
"""Full-catalogue final QQ album dedupe by tracklist.

This pass exists because many Soundive albums render tracks dynamically from NetEase but do not yet
persist `tracks` inside the `albums` collection. It therefore:

1. Reads the remaining QQ candidates from qq_album_need_submit.json.
2. Reads the complete live Soundive albums catalogue.
3. Uses persisted tracks when present.
4. For every NetEase album missing persisted tracks, fetches its album detail from NetEase by sourceId.
5. Caches fetched tracklists locally so repeated runs are fast.
6. Removes QQ candidates when a same-size Soundive album has a strongly overlapping tracklist,
   regardless of album title.

This is intentionally aggressive: it is a final narrowing pass before manual review.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import requests

from fuzzy_prune_existing_albums import (
    CONFIG_FILE,
    extract_candidate_tracks,
    fetch_catalog,
    get_access_token,
    load_json,
)

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = BASE_DIR / "qq_album_need_submit.json"
DEFAULT_OUTPUT = BASE_DIR / "qq_album_need_submit.json"
DEFAULT_REMOVED = BASE_DIR / "qq_album_tracklist_overlap.json"
DEFAULT_CACHE = BASE_DIR / "barscope_album_track_cache.json"

try:
    from opencc import OpenCC  # type: ignore
    OPENCC = OpenCC("t2s")
except Exception:
    OPENCC = None

_thread_local = threading.local()

BRACKET_NOISE_RE = re.compile(
    r"(?:\(|（|\[|【)[^\)）\]】]*(?:explicit|prod\.?|producer|produced\s+by|feat\.?|ft\.?|remaster(?:ed)?|clean|version|版)[^\)）\]】]*(?:\)|）|\]|】)",
    re.IGNORECASE,
)
FEATURE_RE = re.compile(r"\b(?:feat\.?|ft\.?)\s+.*$", re.IGNORECASE)
PROD_RE = re.compile(r"\b(?:prod\.?|produced\s+by)\s*.*$", re.IGNORECASE)
TRAILING_BRACKET_RE = re.compile(r"(?:\s*[\(（\[【].*?[\)）\]】]\s*)+$")


def session() -> requests.Session:
    value = getattr(_thread_local, "session", None)
    if value is None:
        value = requests.Session()
        value.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",
            "Referer": "https://music.163.com/",
            "Accept": "application/json,text/plain,*/*",
        })
        _thread_local.session = value
    return value


def normalize_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    if OPENCC is not None:
        text = OPENCC.convert(text)
    return text


def normalize_track(value: str) -> str:
    text = normalize_text(value)
    text = BRACKET_NOISE_RE.sub("", text)
    text = FEATURE_RE.sub("", text)
    text = PROD_RE.sub("", text)
    text = re.sub(r"\b(?:explicit|remaster(?:ed)?|clean)\b", "", text, flags=re.IGNORECASE)
    text = TRAILING_BRACKET_RE.sub("", text).strip()
    return re.sub(r"[\s\-_·•:：()（）\[\]【】<>《》'\"“”‘’.,，。!?！？&＋+／/\\|]+", "", text)


def extract_tracks(rows: Any) -> list[str]:
    result: list[str] = []
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, str):
            name = row
        elif isinstance(row, dict):
            name = row.get("name") or row.get("title") or row.get("songName") or row.get("songname") or ""
        else:
            name = ""
        value = normalize_track(str(name))
        if value:
            result.append(value)
    return result


def similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        shorter, longer = sorted((len(a), len(b)))
        if shorter >= 2 and longer:
            ratio = shorter / longer
            if ratio >= 0.45:
                return max(0.88, ratio)
    return SequenceMatcher(None, a, b).ratio()


def parse_netease_tracks(payload: dict[str, Any]) -> list[str]:
    album = payload.get("album") or (payload.get("data") or {}).get("album") or {}
    songs = payload.get("songs") or (payload.get("data") or {}).get("songs") or album.get("songs") or []
    names: list[str] = []
    for song in songs if isinstance(songs, list) else []:
        if isinstance(song, dict):
            name = song.get("name") or song.get("title") or ""
            normalized = normalize_track(str(name))
            if normalized:
                names.append(normalized)
    return names


def fetch_netease_tracks(source_id: str) -> list[str]:
    source_id = str(source_id or "").strip()
    if not source_id or not source_id.isdigit():
        return []
    urls = [
        f"https://music.163.com/api/v1/album/{source_id}",
        f"https://music.163.com/api/album/{source_id}",
    ]
    for url in urls:
        try:
            response = session().get(url, timeout=15)
            response.raise_for_status()
            payload = response.json()
            tracks = parse_netease_tracks(payload)
            if tracks:
                return tracks
        except Exception:
            continue
    return []


def load_cache(path: Path) -> dict[str, list[str]]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        rows = payload.get("tracksBySourceId", payload)
        if not isinstance(rows, dict):
            return {}
        return {
            str(key): [str(x) for x in value if str(x)]
            for key, value in rows.items()
            if isinstance(value, list)
        }
    except Exception:
        return {}


def save_cache(path: Path, cache: dict[str, list[str]]) -> None:
    path.write_text(
        json.dumps({"count": len(cache), "tracksBySourceId": cache}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def hydrate_catalog_tracks(
    catalog: list[dict[str, Any]],
    cache_path: Path,
    workers: int,
) -> tuple[list[tuple[dict[str, Any], list[str]]], dict[str, int]]:
    cache = load_cache(cache_path)
    result: list[tuple[dict[str, Any], list[str]]] = []
    missing: list[tuple[int, dict[str, Any], str]] = []
    stats = {"persisted": 0, "cache": 0, "fetched": 0, "failed": 0, "noSourceId": 0}

    resolved_by_index: dict[int, list[str]] = {}
    for index, album in enumerate(catalog):
        persisted = extract_tracks(album.get("tracks") or [])
        if persisted:
            resolved_by_index[index] = persisted
            stats["persisted"] += 1
            continue

        source = str(album.get("source") or "netease").lower()
        source_id = str(album.get("sourceId") or "").strip()
        # QQ-native rows cannot be hydrated through NetEase. Most existing catalogue rows are NetEase-backed.
        if source == "qq" and not source_id.isdigit():
            stats["noSourceId"] += 1
            continue
        if not source_id or not source_id.isdigit():
            stats["noSourceId"] += 1
            continue
        if source_id in cache and cache[source_id]:
            resolved_by_index[index] = cache[source_id]
            stats["cache"] += 1
            continue
        missing.append((index, album, source_id))

    print(
        f"  数据库已持久化 tracks: {stats['persisted']} 张；"
        f"缓存命中: {stats['cache']} 张；待从网易云补抓: {len(missing)} 张"
    )

    if missing:
        completed = 0
        with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
            futures = {
                executor.submit(fetch_netease_tracks, source_id): (index, source_id)
                for index, _album, source_id in missing
            }
            for future in as_completed(futures):
                index, source_id = futures[future]
                completed += 1
                try:
                    tracks = future.result()
                except Exception:
                    tracks = []
                if tracks:
                    resolved_by_index[index] = tracks
                    cache[source_id] = tracks
                    stats["fetched"] += 1
                else:
                    stats["failed"] += 1
                if completed % 100 == 0 or completed == len(missing):
                    print(
                        f"  补抓曲目 {completed}/{len(missing)} · 成功 {stats['fetched']} · 失败 {stats['failed']}"
                    )
                    save_cache(cache_path, cache)

    save_cache(cache_path, cache)
    for index, album in enumerate(catalog):
        tracks = resolved_by_index.get(index) or []
        if tracks:
            result.append((album, tracks))
    return result, stats


def greedy_match(candidate: list[str], existing: list[str]) -> list[float]:
    if len(candidate) != len(existing) or not candidate:
        return []
    unused = set(range(len(existing)))
    scores: list[float] = []
    for name in sorted(candidate, key=len, reverse=True):
        best_index = None
        best_score = -1.0
        for index in unused:
            score = similarity(name, existing[index])
            if score > best_score:
                best_score = score
                best_index = index
        if best_index is None:
            return []
        unused.remove(best_index)
        scores.append(max(0.0, best_score))
    return scores


def evaluate_same_release(candidate: list[str], existing: list[str]) -> dict[str, Any] | None:
    if len(candidate) != len(existing) or len(candidate) < 3:
        return None
    scores = greedy_match(candidate, existing)
    if not scores:
        return None

    count = len(scores)
    exact = sum(x >= 0.95 for x in scores)
    strong = sum(x >= 0.85 for x in scores)
    basic = sum(x >= 0.68 for x in scores)
    average = sum(scores) / count

    # Final aggressive narrowing rule. Any one of these is enough to regard the releases as the same album.
    same = (
        exact >= math.ceil(count * 0.50)
        or strong >= math.ceil(count * 0.65)
        or (basic >= math.ceil(count * 0.80) and average >= 0.72)
        or (count <= 4 and strong >= count - 1)
    )
    if not same:
        return None
    return {
        "trackCount": count,
        "exactishTrackCount": exact,
        "strongTrackCount": strong,
        "matchedTrackCount": basic,
        "averageTrackSimilarity": round(average, 4),
        "trackSimilarityScores": [round(x, 4) for x in sorted(scores, reverse=True)],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="用完整 Soundive 曲目库再次压缩 QQ 专辑候选")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--removed-output", default=str(DEFAULT_REMOVED))
    parser.add_argument("--cache", default=str(DEFAULT_CACHE))
    parser.add_argument("--workers", type=int, default=12)
    args = parser.parse_args()

    source = load_json(Path(args.input))
    candidates = source.get("results", []) or []
    cfg = load_json(CONFIG_FILE)
    token = get_access_token(str(cfg.get("appid") or ""), str(cfg.get("appsecret") or ""))
    env = str(cfg.get("env") or "")

    print(f"读取剩余 QQ 候选 {len(candidates)} 张；读取完整 Soundive 专辑库……")
    catalog = fetch_catalog(token, env)
    if not catalog:
        raise SystemExit("错误：Soundive 专辑库读取为 0，本次不会覆盖候选文件。")

    hydrated, stats = hydrate_catalog_tracks(catalog, Path(args.cache), args.workers)
    by_count: dict[int, list[tuple[dict[str, Any], list[str]]]] = {}
    for album, tracks in hydrated:
        by_count.setdefault(len(tracks), []).append((album, tracks))

    candidate_track_count = sum(1 for x in candidates if extract_candidate_tracks(x))
    print(
        f"曲目覆盖完成：{len(hydrated)}/{len(catalog)} 张 Soundive 专辑可参与曲目查重；"
        f"QQ 候选有 tracks：{candidate_track_count}/{len(candidates)}"
    )

    kept: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    no_tracks = 0

    for index, item in enumerate(candidates, 1):
        candidate_tracks = extract_candidate_tracks(item)
        if not candidate_tracks:
            no_tracks += 1
            kept.append(item)
            continue

        best_album = None
        best_evidence = None
        best_rank = (-1, -1, -1, -1.0)
        for album, existing_tracks in by_count.get(len(candidate_tracks), []):
            evidence = evaluate_same_release(candidate_tracks, existing_tracks)
            if evidence is None:
                continue
            rank = (
                int(evidence["exactishTrackCount"]),
                int(evidence["strongTrackCount"]),
                int(evidence["matchedTrackCount"]),
                float(evidence["averageTrackSimilarity"]),
            )
            if rank > best_rank:
                best_rank = rank
                best_album = album
                best_evidence = evidence

        if best_album is not None and best_evidence is not None:
            removed.append({
                **item,
                "matchedExistingAlbumId": best_album.get("_id"),
                "matchedExistingTitle": best_album.get("title"),
                "matchedExistingSourceId": best_album.get("sourceId"),
                **best_evidence,
                "filterReason": (
                    f"完整曲目库查重：曲目数同为 {best_evidence['trackCount']}，"
                    f"{best_evidence['strongTrackCount']} 首强匹配，"
                    f"{best_evidence['exactishTrackCount']} 首近乎完全一致"
                ),
                "filteredBy": "full_catalog_tracklist_similarity",
            })
        else:
            kept.append(item)

        if index % 25 == 0 or index == len(candidates):
            print(f"  全库曲目查重 {index}/{len(candidates)} · 剔除 {len(removed)} · 保留 {len(kept)}")

    Path(args.output).write_text(
        json.dumps({"source": "qq_album_need_submit_full_track_pruned", "count": len(kept), "results": kept}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    Path(args.removed_output).write_text(
        json.dumps({
            "source": "qq_album_tracklist_overlap",
            "count": len(removed),
            "catalogCount": len(catalog),
            "catalogWithTracks": len(hydrated),
            "hydrateStats": stats,
            "results": removed,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("\n完成")
    print(f"Soundive 专辑总数:              {len(catalog)}")
    print(f"最终可参与曲目查重:             {len(hydrated)}")
    print(f"本轮按完整 tracklist 剔除:      {len(removed)} -> {args.removed_output}")
    print(f"QQ 候选无 tracks:               {no_tracks}")
    print(f"最终剩余需要提交:               {len(kept)} -> {args.output}")


if __name__ == "__main__":
    main()
