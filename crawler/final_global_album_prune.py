#!/usr/bin/env python3
"""Final global QQ album dedupe against the full BarScope catalogue.

This pass intentionally ignores artist ownership. It removes a QQ candidate when any of these is true:
1) its normalized album title strongly matches any existing BarScope album title;
2) its track count matches and the tracklist strongly describes the same release; or
3) its title clearly looks like programme / event / campaign content that BarScope does not want as an album.

It reuses final_tracklist_prune.py to hydrate the full BarScope catalogue with NetEase tracklists.
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from fuzzy_prune_existing_albums import CONFIG_FILE, extract_candidate_tracks, fetch_catalog, get_access_token, load_json
from final_tracklist_prune import DEFAULT_CACHE, evaluate_same_release, hydrate_catalog_tracks

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = BASE_DIR / "qq_album_need_submit.json"
DEFAULT_OUTPUT = BASE_DIR / "qq_album_need_submit.json"
DEFAULT_REMOVED = BASE_DIR / "qq_album_global_overlap.json"

try:
    from opencc import OpenCC  # type: ignore
    OPENCC = OpenCC("t2s")
except Exception:
    OPENCC = None

TITLE_SUFFIX_RE = re.compile(
    r"(?:\s*[\(（\[【].*?(?:explicit|deluxe|extended|remaster(?:ed)?|clean|version|版).*?[\)）\]】]\s*)+$",
    re.IGNORECASE,
)

# Final content-quality blacklist requested for the QQ discovery pool.
# Keep this deliberately focused on programme/event/campaign releases; do not blacklist generic "Vol.".
CONTENT_BLACKLIST_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("企划", re.compile(r"企划|企劃", re.IGNORECASE)),
    ("说唱梦工厂", re.compile(r"说唱梦工厂|說唱夢工廠", re.IGNORECASE)),
    ("演唱会", re.compile(r"演唱会|演唱會|concert", re.IGNORECASE)),
    ("音乐节/现场活动", re.compile(r"音乐节|音樂節|live\s*(?:at|from|in)\b|现场演出|現場演出", re.IGNORECASE)),
    ("节目期数", re.compile(r"(?:第\s*[一二三四五六七八九十百零〇0-9]+\s*期)|(?:\bep(?:isode)?\.?\s*\d+\b)", re.IGNORECASE)),
    ("综艺/节目", re.compile(r"中国新说唱|中國新說唱|中国有嘻哈|中國有嘻哈|说唱新世代|說唱新世代|巅峰对决|巔峰對決", re.IGNORECASE)),
]


def normalize_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    # Strip zero-width/BOM and all Unicode format controls. These can make visually identical titles fail exact matching.
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    if OPENCC is not None:
        text = OPENCC.convert(text)
    return text


def normalize_title(value: str) -> str:
    text = normalize_text(value)
    text = TITLE_SUFFIX_RE.sub("", text)
    text = re.sub(r"\b(?:explicit|deluxe|extended|remaster(?:ed)?|clean)\b", "", text, flags=re.IGNORECASE)
    return re.sub(r"[\s\-_·•:：()（）\[\]【】<>《》'\"“”‘’.,，。!?！？&＋+／/\\|]+", "", text)


def title_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    ratio = SequenceMatcher(None, a, b).ratio()
    if a in b or b in a:
        shorter, longer = sorted((len(a), len(b)))
        if shorter >= 3 and longer:
            containment = shorter / longer
            # A full title plus a short platform suffix/subtitle is usually the same release.
            if containment >= 0.60:
                ratio = max(ratio, 0.90)
            else:
                ratio = max(ratio, containment)
    return ratio


def content_blacklist_reason(title: str) -> str | None:
    normalized = normalize_text(title)
    for label, pattern in CONTENT_BLACKLIST_PATTERNS:
        if pattern.search(normalized):
            return label
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="忽略艺人归属，按全库专辑名 + tracks + 内容规则最终压缩 QQ 候选")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--removed-output", default=str(DEFAULT_REMOVED))
    parser.add_argument("--cache", default=str(DEFAULT_CACHE))
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--title-threshold", type=float, default=0.70)
    args = parser.parse_args()

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
    by_count: dict[int, list[tuple[dict[str, Any], list[str]]]] = {}
    for album, tracks in hydrated:
        by_count.setdefault(len(tracks), []).append((album, tracks))

    title_catalog = [
        (album, normalize_title(str(album.get("title") or "")))
        for album in catalog
        if str(album.get("title") or "").strip()
    ]
    # Exact normalized title map catches visually identical titles before fuzzy scoring.
    exact_title_map: dict[str, dict[str, Any]] = {}
    for album, album_norm in title_catalog:
        if album_norm and album_norm not in exact_title_map:
            exact_title_map[album_norm] = album

    kept: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    rule_removed = 0
    title_removed = 0
    track_removed = 0

    for index, item in enumerate(candidates, 1):
        candidate_title = str(item.get("title") or "")
        candidate_norm = normalize_title(candidate_title)

        blacklist_reason = content_blacklist_reason(candidate_title)
        if blacklist_reason:
            rule_removed += 1
            removed.append({
                **item,
                "filterReason": f"最终内容规则剔除：标题命中「{blacklist_reason}」类非标准专辑内容",
                "filteredBy": "final_content_blacklist",
            })
            continue

        exact_album = exact_title_map.get(candidate_norm)
        if exact_album is not None:
            title_removed += 1
            removed.append({
                **item,
                "matchedExistingAlbumId": exact_album.get("_id"),
                "matchedExistingTitle": exact_album.get("title"),
                "matchedExistingSourceId": exact_album.get("sourceId"),
                "titleSimilarity": 1.0,
                "filterReason": "忽略艺人归属的全库专辑名查重：标准化标题完全一致",
                "filteredBy": "global_album_title_exact_no_artist",
            })
            continue

        best_title_album = None
        best_title_score = 0.0
        for album, album_norm in title_catalog:
            score = title_similarity(candidate_norm, album_norm)
            if score > best_title_score:
                best_title_score = score
                best_title_album = album
                if score >= 1.0:
                    break

        if best_title_album is not None and best_title_score >= args.title_threshold:
            title_removed += 1
            removed.append({
                **item,
                "matchedExistingAlbumId": best_title_album.get("_id"),
                "matchedExistingTitle": best_title_album.get("title"),
                "matchedExistingSourceId": best_title_album.get("sourceId"),
                "titleSimilarity": round(best_title_score, 4),
                "filterReason": f"忽略艺人归属的全库专辑名查重：标题相似度 {best_title_score:.0%}",
                "filteredBy": "global_album_title_similarity_no_artist",
            })
            continue

        candidate_tracks = extract_candidate_tracks(item)
        best_album = None
        best_evidence = None
        best_rank = (-1, -1, -1, -1.0)

        if candidate_tracks:
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
            track_removed += 1
            removed.append({
                **item,
                "matchedExistingAlbumId": best_album.get("_id"),
                "matchedExistingTitle": best_album.get("title"),
                "matchedExistingSourceId": best_album.get("sourceId"),
                **best_evidence,
                "filterReason": (
                    f"忽略艺人归属的全库 tracks 查重：曲目数同为 {best_evidence['trackCount']}，"
                    f"{best_evidence['strongTrackCount']} 首强匹配，"
                    f"{best_evidence['exactishTrackCount']} 首近乎完全一致"
                ),
                "filteredBy": "global_tracklist_similarity_no_artist",
            })
        else:
            kept.append(item)

        if index % 25 == 0 or index == len(candidates):
            print(
                f"  全局查重 {index}/{len(candidates)} · "
                f"规则剔除 {rule_removed} · 标题剔除 {title_removed} · tracks 剔除 {track_removed} · 保留 {len(kept)}"
            )

    Path(args.output).write_text(
        json.dumps({"source": "qq_album_need_submit_global_pruned", "count": len(kept), "results": kept}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    Path(args.removed_output).write_text(
        json.dumps({
            "source": "qq_album_global_overlap",
            "count": len(removed),
            "catalogCount": len(catalog),
            "catalogWithTracks": len(hydrated),
            "hydrateStats": stats,
            "titleThreshold": args.title_threshold,
            "ruleRemoved": rule_removed,
            "titleRemoved": title_removed,
            "trackRemoved": track_removed,
            "results": removed,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("\n完成")
    print(f"内容规则剔除:                  {rule_removed}")
    print(f"标题查重剔除:                  {title_removed}")
    print(f"tracks 查重剔除:               {track_removed}")
    print(f"总剔除:                        {len(removed)} -> {args.removed_output}")
    print(f"最终剩余需要提交:              {len(kept)} -> {args.output}")


if __name__ == "__main__":
    main()
