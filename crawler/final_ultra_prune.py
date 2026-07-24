#!/usr/bin/env python3
"""Ultra-aggressive final QQ album dedupe against the entire Soundive catalogue.

Rules requested for the final manual-review pool:
1. Ignore artist ownership completely. If a candidate album title is >= 50% similar to ANY Soundive album title, remove it.
2. Ignore artist ownership and album track-count equality. If a candidate shares at least 3 one-to-one matching track names
   with ANY Soundive album, remove it.

Besides JSON outputs for downstream scripts, this script writes three human-review CSV files:
- qq_album_need_submit.csv: final kept albums
- qq_album_ultra_overlap.csv: removed albums with evidence
- qq_album_full_review.csv: EVERY input candidate with its final decision and strongest audit evidence
"""

from __future__ import annotations

import argparse
import csv
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
DEFAULT_KEPT_CSV = BASE_DIR / "qq_album_need_submit.csv"
DEFAULT_REMOVED_CSV = BASE_DIR / "qq_album_ultra_overlap.csv"
DEFAULT_REVIEW_CSV = BASE_DIR / "qq_album_full_review.csv"


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


def first_value(item: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = item.get(key)
        if value not in (None, "", [], {}):
            return value
    return ""


def stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def artist_text(item: dict[str, Any]) -> str:
    value = first_value(item, ("artist", "artistName", "singer", "singerName", "artists", "singers"))
    if isinstance(value, list):
        names: list[str] = []
        for row in value:
            if isinstance(row, dict):
                name = row.get("name") or row.get("artistName") or row.get("singerName") or row.get("title")
                if name:
                    names.append(str(name))
            elif row not in (None, ""):
                names.append(str(row))
        return " | ".join(names)
    return stringify(value)


def raw_track_names(item: dict[str, Any]) -> list[str]:
    rows = item.get("tracks") or item.get("songs") or item.get("songList") or []
    names: list[str] = []
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict):
            name = row.get("name") or row.get("title") or row.get("songName") or row.get("songname")
            if name:
                names.append(str(name))
        elif row not in (None, ""):
            names.append(str(row))
    return names


def compact_pairs(pairs: list[dict[str, Any]]) -> str:
    return " | ".join(
        f"{pair.get('candidate', '')} ↔ {pair.get('existing', '')} ({float(pair.get('similarity') or 0):.0%})"
        for pair in pairs
    )


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def base_csv_row(item: dict[str, Any]) -> dict[str, Any]:
    tracks = raw_track_names(item)
    return {
        "QQ专辑名": str(item.get("title") or ""),
        "艺人": artist_text(item),
        "发行日期": stringify(first_value(item, ("releaseDate", "publishDate", "date"))),
        "曲目数": len(tracks) if tracks else len(extract_candidate_tracks(item)),
        "Tracks": " | ".join(tracks),
        "QQ Album ID": stringify(first_value(item, ("albumMid", "albumMID", "qqAlbumId", "albumId", "mid", "id"))),
        "QQ链接": stringify(first_value(item, ("url", "albumUrl", "qqUrl", "link"))),
        "网易云映射艺人ID": stringify(item.get("neteaseArtistId")),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="最终极限压缩：全库标题>=50%或任意3首tracks重合即删除，并输出完整CSV审核表")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--removed-output", default=str(DEFAULT_REMOVED))
    parser.add_argument("--kept-csv", default=str(DEFAULT_KEPT_CSV))
    parser.add_argument("--removed-csv", default=str(DEFAULT_REMOVED_CSV))
    parser.add_argument("--review-csv", default=str(DEFAULT_REVIEW_CSV))
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

    print(f"读取剩余 QQ 候选 {len(candidates)} 张；读取完整 Soundive 专辑库……")
    catalog = fetch_catalog(token, env)
    if not catalog:
        raise SystemExit("错误：Soundive 专辑库读取为 0，本次不会覆盖候选文件。")

    hydrated, stats = hydrate_catalog_tracks(catalog, Path(args.cache), args.workers)
    title_catalog = [
        (album, normalize_title(str(album.get("title") or "")))
        for album in catalog
        if str(album.get("title") or "").strip()
    ]

    kept: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    kept_csv_rows: list[dict[str, Any]] = []
    removed_csv_rows: list[dict[str, Any]] = []
    review_csv_rows: list[dict[str, Any]] = []
    title_removed = 0
    track_removed = 0
    no_tracks = 0

    for index, item in enumerate(candidates, 1):
        candidate_title = str(item.get("title") or "")
        candidate_norm = normalize_title(candidate_title)

        # Always calculate strongest title evidence for the audit CSV.
        best_title_album = None
        best_title_score = 0.0
        for album, album_norm in title_catalog:
            score = title_similarity(candidate_norm, album_norm)
            if score > best_title_score:
                best_title_score = score
                best_title_album = album
                if score >= 1.0:
                    break

        # Always calculate strongest track evidence too, even if the title rule already removes the album.
        candidate_tracks = extract_candidate_tracks(item)
        best_track_album = None
        best_pairs: list[dict[str, Any]] = []
        if candidate_tracks:
            for album, existing_tracks in hydrated:
                overlap_count, pairs = greedy_overlap(candidate_tracks, existing_tracks, track_threshold)
                if overlap_count > len(best_pairs):
                    best_track_album = album
                    best_pairs = pairs
        else:
            no_tracks += 1

        title_hit = best_title_album is not None and best_title_score >= title_threshold
        track_hit = best_track_album is not None and len(best_pairs) >= min_track_overlap

        if title_hit and track_hit:
            decision = "删除"
            decision_reason = f"标题相似度≥{title_threshold:.0%} 且 Tracks重合≥{min_track_overlap}首"
            filtered_by = "ultra_title_and_track_overlap"
            title_removed += 1
        elif title_hit:
            decision = "删除"
            decision_reason = f"标题相似度≥{title_threshold:.0%}"
            filtered_by = "ultra_global_title_similarity"
            title_removed += 1
        elif track_hit:
            decision = "删除"
            decision_reason = f"Tracks重合≥{min_track_overlap}首"
            filtered_by = "ultra_global_three_track_overlap"
            track_removed += 1
        else:
            decision = "保留审核"
            decision_reason = "未命中自动删除规则"
            filtered_by = "manual_review"

        matched_title_album = best_title_album or {}
        matched_track_album = best_track_album or {}
        audit_row = {
            **base_csv_row(item),
            "审核结果": decision,
            "审核原因": decision_reason,
            "最佳标题匹配专辑": stringify(matched_title_album.get("title")),
            "最佳标题匹配专辑ID": stringify(matched_title_album.get("_id")),
            "标题相似度": round(best_title_score, 4),
            "标题相似度百分比": f"{best_title_score:.1%}",
            "最佳Tracks匹配专辑": stringify(matched_track_album.get("title")),
            "最佳Tracks匹配专辑ID": stringify(matched_track_album.get("_id")),
            "重合Tracks数": len(best_pairs),
            "重合Tracks详情": compact_pairs(best_pairs),
            "删除规则": filtered_by,
        }
        review_csv_rows.append(audit_row)

        if decision == "删除":
            evidence_album = best_title_album if title_hit else best_track_album
            removal = {
                **item,
                "matchedExistingAlbumId": (evidence_album or {}).get("_id"),
                "matchedExistingTitle": (evidence_album or {}).get("title"),
                "matchedExistingSourceId": (evidence_album or {}).get("sourceId"),
                "bestTitleMatchedAlbumId": matched_title_album.get("_id"),
                "bestTitleMatchedAlbumTitle": matched_title_album.get("title"),
                "titleSimilarity": round(best_title_score, 4),
                "bestTrackMatchedAlbumId": matched_track_album.get("_id"),
                "bestTrackMatchedAlbumTitle": matched_track_album.get("title"),
                "matchedTrackCount": len(best_pairs),
                "trackMatchPairs": best_pairs,
                "filterReason": decision_reason,
                "filteredBy": filtered_by,
            }
            removed.append(removal)
            removed_csv_rows.append(audit_row)
        else:
            kept.append(item)
            kept_csv_rows.append(audit_row)

        if index % 25 == 0 or index == len(candidates):
            print(
                f"  极限查重 {index}/{len(candidates)} · "
                f"标题规则剔除 {title_removed} · Tracks规则剔除 {track_removed} · 保留 {len(kept)}"
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

    csv_fields = [
        "审核结果", "审核原因", "QQ专辑名", "艺人", "发行日期", "曲目数", "Tracks",
        "QQ Album ID", "QQ链接", "网易云映射艺人ID",
        "最佳标题匹配专辑", "最佳标题匹配专辑ID", "标题相似度", "标题相似度百分比",
        "最佳Tracks匹配专辑", "最佳Tracks匹配专辑ID", "重合Tracks数", "重合Tracks详情", "删除规则",
    ]
    write_csv(Path(args.kept_csv), kept_csv_rows, csv_fields)
    write_csv(Path(args.removed_csv), removed_csv_rows, csv_fields)
    write_csv(Path(args.review_csv), review_csv_rows, csv_fields)

    print("\n完成")
    print(f"全库标题相似度 >= {title_threshold:.0%} 规则剔除: {title_removed}")
    print(f"全库 tracks 重合 >= {min_track_overlap} 首规则剔除: {track_removed}")
    print(f"候选无 tracks:                              {no_tracks}")
    print(f"总剔除:                                      {len(removed)} -> {args.removed_output}")
    print(f"最终剩余需要提交:                            {len(kept)} -> {args.output}")
    print(f"最终保留 CSV:                                {args.kept_csv}")
    print(f"删除审核 CSV:                                {args.removed_csv}")
    print(f"全部候选完整审核 CSV:                         {args.review_csv}")


if __name__ == "__main__":
    main()
