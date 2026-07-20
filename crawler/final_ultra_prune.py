#!/usr/bin/env python3
"""Ultra-aggressive final QQ album dedupe against the entire BarScope catalogue.

Rules requested for the final manual-review pool:
1. Ignore artist ownership completely. If a candidate album title is >= 50% similar to ANY BarScope album title, remove it.
2. Ignore artist ownership and album track-count equality. If a candidate shares at least 3 one-to-one matching track names
   with ANY BarScope album, remove it.

This script reuses the full-catalogue track hydration/cache built by final_tracklist_prune.py.
It overwrites qq_album_need_submit.json and writes removals to qq_album_ultra_overlap.json.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from fuzzy_prune_existing_albums import (
    CONFIG_FILE,
    extract_candidate_tracks,
    fetch_catalog,
    get_access_token,
    load_json,
)
from final_global_album_prune import normalize_title, title_similarity
from final_tracklist_prune import DEFAULT_CACHE, hydrate_catalog_tracks, similarity

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = BASE_DIR / "qq_album_need_submit.json"
DEFAULT_OUTPUT = BASE_DIR / "qq_album_need_submit.json"
DEFAULT_REMOVED = BASE_DIR / "qq_album_ultra_overlap.json"


def greedy_overlap(
    candidate_tracks: list[str],
    existing_tracks: list[str],
    per_track_threshold: float,
) -> tuple[int, list[dict[str, Any]]]:
    """Count unique one-to-one track-name matches without requiring equal album sizes or track order."""
    if not candidate_tracks or not existing_tracks:
        return 0, []

    unused = set(range(len(existing_tracks)))
    pairs: list[dict[str, Any]] = []

    # Long/distinctive names first reduces collisions between short generic titles such as Intro/Outro.
    for candidate in sorted(candidate_tracks, key=len, reverse=True):
        best_index = None
        best_score = -1.0
        for index in unused:
            score = similarity(candidate, existing_tracks[index])
            if score > best_score:
                best_score = score
                best_index = index

        if best_index is None or best_score < per_track_threshold:
            continue

        unused.remove(best_index)
        pairs.append({
            "candidate": candidate,
            "existing": existing_tracks[best_index],
            "similarity": round(best_score, 4),
        })

    return len(pairs), pairs


def main() -> None:
    parser = argparse.ArgumentParser(description="最终极限压缩：全库标题>=50%或任意3首tracks重合即删除")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--removed-output", default=str(DEFAULT_REMOVED))
    parser.add_argument("--cache", default=str(DEFAULT_CACHE))
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--title-threshold", type=float, default=0.50)
    parser.add_argument("--track-threshold", type=float, default=0.68)
    parser.add_argument("--min-track-overlap", type=int, default=3)
    args = parser.parse_args()

    title_threshold = max(0.0, min(1.0, float(args.title_threshold)))
    track_threshold = max(0.0, min(1.0, float(args.track_threshold)))
    min_track_overlap = max(1, int(args.min_track_overlap))

    source = load_json(Path(args.input))
    candidates = source.get("results", []) or []

    cfg = load_json(CONFIG_FILE)
    token = get_access_token(str(cfg.get("appid") or ""), str(cfg.get("appsecret") or ""))
    env = str(cfg.get("env") or "")

    print(f"读取剩余 QQ 候选 {len(candidates)} 张；读取完整 BarScope 专辑库……")
    catalog = fetch_catalog(token, env)
    if not catalog:
        raise SystemExit("错误：BarScope 专辑库读取为 0，本次不会覆盖候选文件。")

    hydrated, stats = hydrate_catalog_tracks(catalog, Path(args.cache), args.workers)
    title_catalog = [
        (album, normalize_title(str(album.get("title") or "")))
        for album in catalog
        if str(album.get("title") or "").strip()
    ]

    kept: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    title_removed = 0
    track_removed = 0
    no_tracks = 0

    for index, item in enumerate(candidates, 1):
        candidate_title = str(item.get("title") or "")
        candidate_norm = normalize_title(candidate_title)

        # Rule 1: ANY album title >= 50% similarity. Artist identity is intentionally ignored.
        best_title_album = None
        best_title_score = 0.0
        for album, album_norm in title_catalog:
            score = title_similarity(candidate_norm, album_norm)
            if score > best_title_score:
                best_title_score = score
                best_title_album = album
                if score >= 1.0:
                    break

        if best_title_album is not None and best_title_score >= title_threshold:
            title_removed += 1
            removed.append({
                **item,
                "matchedExistingAlbumId": best_title_album.get("_id"),
                "matchedExistingTitle": best_title_album.get("title"),
                "matchedExistingSourceId": best_title_album.get("sourceId"),
                "titleSimilarity": round(best_title_score, 4),
                "filterReason": f"全库极限标题查重：忽略艺人，标题相似度 {best_title_score:.0%} >= {title_threshold:.0%}",
                "filteredBy": "ultra_global_title_similarity",
            })
            continue

        # Rule 2: ANY existing album with >=3 unique matching tracks. Album sizes may differ.
        candidate_tracks = extract_candidate_tracks(item)
        if not candidate_tracks:
            no_tracks += 1
            kept.append(item)
            continue

        best_track_album = None
        best_pairs: list[dict[str, Any]] = []
        for album, existing_tracks in hydrated:
            overlap_count, pairs = greedy_overlap(candidate_tracks, existing_tracks, track_threshold)
            if overlap_count > len(best_pairs):
                best_track_album = album
                best_pairs = pairs
            if overlap_count >= min_track_overlap:
                # Three matches are already sufficient by user rule; no need to scan the rest of the catalogue.
                best_track_album = album
                best_pairs = pairs
                break

        if best_track_album is not None and len(best_pairs) >= min_track_overlap:
            track_removed += 1
            removed.append({
                **item,
                "matchedExistingAlbumId": best_track_album.get("_id"),
                "matchedExistingTitle": best_track_album.get("title"),
                "matchedExistingSourceId": best_track_album.get("sourceId"),
                "candidateTrackCount": len(candidate_tracks),
                "existingTrackCount": len(next((tracks for album, tracks in hydrated if album is best_track_album), [])),
                "matchedTrackCount": len(best_pairs),
                "trackMatchPairs": best_pairs,
                "filterReason": (
                    f"全库极限 tracks 查重：忽略艺人和曲目总数，至少 {len(best_pairs)} 首曲目重合 "
                    f"(阈值 {track_threshold:.0%})"
                ),
                "filteredBy": "ultra_global_three_track_overlap",
            })
        else:
            kept.append(item)

        if index % 25 == 0 or index == len(candidates):
            print(
                f"  极限查重 {index}/{len(candidates)} · "
                f"标题>=50%剔除 {title_removed} · >=3首重合剔除 {track_removed} · 保留 {len(kept)}"
            )

    Path(args.output).write_text(
        json.dumps({
            "source": "qq_album_need_submit_ultra_pruned",
            "count": len(kept),
            "results": kept,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    Path(args.removed_output).write_text(
        json.dumps({
            "source": "qq_album_ultra_overlap",
            "count": len(removed),
            "catalogCount": len(catalog),
            "catalogWithTracks": len(hydrated),
            "hydrateStats": stats,
            "titleThreshold": title_threshold,
            "trackThreshold": track_threshold,
            "minTrackOverlap": min_track_overlap,
            "titleRemoved": title_removed,
            "trackRemoved": track_removed,
            "results": removed,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("\n完成")
    print(f"全库标题相似度 >= {title_threshold:.0%} 剔除:   {title_removed}")
    print(f"全库 tracks 重合 >= {min_track_overlap} 首剔除:    {track_removed}")
    print(f"候选无 tracks:                         {no_tracks}")
    print(f"总剔除:                                 {len(removed)} -> {args.removed_output}")
    print(f"最终剩余需要提交:                       {len(kept)} -> {args.output}")


if __name__ == "__main__":
    main()
