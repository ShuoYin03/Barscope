#!/usr/bin/env python3
"""Final aggressive dedupe for QQ album candidates against the live Soundive catalogue.

Rules:
1. Remove when normalized album-title similarity >= 70%.
2. Remove when track count matches an existing album and the track lists clearly describe the same release,
   even if the album titles differ.

The track-list pass is deliberately aggressive because this script is the final narrowing pass before manual review.
It compares tracks independent of order and strips common platform/version noise such as Explicit, Prod., feat.,
parenthesized translations and punctuation before comparing.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import requests

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"

try:
    from opencc import OpenCC  # type: ignore
    OPENCC = OpenCC("t2s")
except Exception:
    OPENCC = None

PLATFORM_SUFFIX_RE = re.compile(
    r"(?:[\s\-–—_:：]*[\(\[（【]?\s*(?:explicit|deluxe|extended|remaster(?:ed)?|clean)\s*[\)\]）】]?\s*$)",
    re.IGNORECASE,
)

# Noise that frequently differs between QQ and NetEase while the underlying song is identical.
TRACK_BRACKET_NOISE_RE = re.compile(
    r"(?:\(|（|\[|【)[^\)）\]】]*(?:explicit|prod\.?|producer|produced\s+by|feat\.?|ft\.?|remaster(?:ed)?|clean|version|版)[^\)）\]】]*(?:\)|）|\]|】)",
    re.IGNORECASE,
)
TRACK_TRAILING_CREDIT_RE = re.compile(
    r"(?:\s*[\(（\[【].*?[\)）\]】]\s*)+$",
    re.IGNORECASE,
)
FEATURE_RE = re.compile(r"\b(?:feat\.?|ft\.?)\s+.*$", re.IGNORECASE)
PROD_RE = re.compile(r"\b(?:prod\.?|produced\s+by)\s*.*$", re.IGNORECASE)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def get_access_token(appid: str, appsecret: str) -> str:
    r = requests.get(
        "https://api.weixin.qq.com/cgi-bin/token",
        params={"grant_type": "client_credential", "appid": appid, "secret": appsecret},
        timeout=15,
    )
    r.raise_for_status()
    payload = r.json()
    token = payload.get("access_token")
    if not token:
        raise RuntimeError(f"获取 access_token 失败: {payload}")
    return str(token)


def invoke_catalog_page(token: str, env: str, offset: int, limit: int = 100) -> dict[str, Any]:
    r = requests.post(
        "https://api.weixin.qq.com/tcb/invokecloudfunction",
        params={"access_token": token, "env": env, "name": "fastCompareQQAlbums"},
        json={"action": "catalogPage", "offset": offset, "limit": limit},
        timeout=60,
    )
    r.raise_for_status()
    payload = r.json()
    if payload.get("errcode", 0) != 0:
        raise RuntimeError(f"云函数调用失败: {payload}")
    result = json.loads(payload.get("resp_data", "{}"))
    if not result.get("success"):
        raise RuntimeError(result.get("error") or "catalogPage failed")
    return result


def normalize_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    if OPENCC is not None:
        text = OPENCC.convert(text)
    return text


def normalize_title(value: str) -> str:
    text = normalize_text(value)
    old = None
    while old != text:
        old = text
        text = PLATFORM_SUFFIX_RE.sub("", text).strip()
    text = re.sub(r"\bexplicit\b", "", text, flags=re.IGNORECASE)
    return re.sub(r"[\s\-_·•:：()（）\[\]【】<>《》'\"“”‘’.,，。!?！？&＋+／/\\|]+", "", text)


def normalize_track(value: str) -> str:
    text = normalize_text(value)
    text = TRACK_BRACKET_NOISE_RE.sub("", text)
    text = FEATURE_RE.sub("", text)
    text = PROD_RE.sub("", text)
    text = re.sub(r"\b(?:explicit|remaster(?:ed)?|clean)\b", "", text, flags=re.IGNORECASE)
    # Remove trailing parenthetical/bracketed credits/translations. This is intentionally aggressive in final dedupe.
    text = TRACK_TRAILING_CREDIT_RE.sub("", text).strip()
    return re.sub(r"[\s\-_·•:：()（）\[\]【】<>《》'\"“”‘’.,，。!?！？&＋+／/\\|]+", "", text)


def similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        shorter, longer = sorted((len(a), len(b)))
        if shorter >= 2:
            ratio = shorter / longer if longer else 0.0
            # Song titles often gain an English translation / credit suffix on one platform.
            if ratio >= 0.45:
                return max(0.88, ratio)
    return SequenceMatcher(None, a, b).ratio()


def fetch_catalog(token: str, env: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        result = invoke_catalog_page(token, env, offset, 100)
        page = result.get("rows", []) or []
        rows.extend(page)
        print(f"  已读取小程序专辑库 {len(rows)} 张")
        if not result.get("hasMore") or not page:
            break
        offset += len(page)
    return rows


def extract_tracks(rows: Any) -> list[str]:
    result: list[str] = []
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, str):
            name = row
        elif isinstance(row, dict):
            name = row.get("name") or row.get("title") or row.get("songName") or row.get("songname") or ""
        else:
            name = ""
        normalized = normalize_track(str(name))
        if normalized:
            result.append(normalized)
    return result


def extract_candidate_tracks(item: dict[str, Any]) -> list[str]:
    return extract_tracks(item.get("tracksDetailed") or item.get("tracks") or [])


def extract_existing_tracks(album: dict[str, Any]) -> list[str]:
    return extract_tracks(album.get("tracks") or [])


def greedy_track_match(candidate_tracks: list[str], existing_tracks: list[str]) -> tuple[list[float], list[tuple[str, str, float]]]:
    """One-to-one best matching, independent of track order."""
    if len(candidate_tracks) != len(existing_tracks) or not candidate_tracks:
        return [], []

    unused = set(range(len(existing_tracks)))
    scores: list[float] = []
    pairs: list[tuple[str, str, float]] = []
    # Match the most distinctive / longest names first to reduce greedy collisions on short generic titles.
    for candidate in sorted(candidate_tracks, key=len, reverse=True):
        best_idx = None
        best_score = -1.0
        for idx in unused:
            score = similarity(candidate, existing_tracks[idx])
            if score > best_score:
                best_score = score
                best_idx = idx
        if best_idx is None:
            continue
        unused.remove(best_idx)
        scores.append(max(0.0, best_score))
        pairs.append((candidate, existing_tracks[best_idx], max(0.0, best_score)))
    return scores, pairs


def best_tracklist_match(
    candidate_tracks: list[str],
    catalog_with_tracks: list[tuple[dict[str, Any], list[str]]],
    per_track_threshold: float,
    required_ratio: float,
    min_average: float,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if not candidate_tracks:
        return None, None

    candidate_count = len(candidate_tracks)
    best_album: dict[str, Any] | None = None
    best_evidence: dict[str, Any] | None = None

    for album, existing_tracks in catalog_with_tracks:
        # User rule: only compare albums with the same number of tracks.
        if len(existing_tracks) != candidate_count:
            continue

        scores, pairs = greedy_track_match(candidate_tracks, existing_tracks)
        if not scores:
            continue
        matched_count = sum(score >= per_track_threshold for score in scores)
        strong_count = sum(score >= 0.85 for score in scores)
        exactish_count = sum(score >= 0.95 for score in scores)
        ratio = matched_count / candidate_count
        average = sum(scores) / candidate_count

        # Aggressive final-pass rule:
        # A) normal threshold: most tracks align; OR
        # B) at least half are very strong matches and overall similarity is still healthy; OR
        # C) for tiny 3-4 track releases, all but at most one track clearly match.
        required_matches = max(2, math.ceil(candidate_count * required_ratio))
        tiny_release_match = candidate_count <= 4 and strong_count >= candidate_count - 1
        strong_core_match = strong_count >= math.ceil(candidate_count * 0.50) and average >= 0.68
        normal_match = matched_count >= required_matches and average >= min_average
        exact_core_match = exactish_count >= math.ceil(candidate_count * 0.50)

        if not (normal_match or strong_core_match or tiny_release_match or exact_core_match):
            continue

        evidence = {
            "matchedTrackCount": matched_count,
            "strongTrackCount": strong_count,
            "exactishTrackCount": exactish_count,
            "trackCount": candidate_count,
            "matchedTrackRatio": round(ratio, 4),
            "averageTrackSimilarity": round(average, 4),
            "trackSimilarityScores": [round(x, 4) for x in sorted(scores, reverse=True)],
            "trackMatchPairs": [
                {"candidate": a, "existing": b, "similarity": round(score, 4)}
                for a, b, score in pairs
            ],
        }
        rank = (exactish_count, strong_count, matched_count, average)
        current_rank = (-1, -1, -1, -1.0)
        if best_evidence is not None:
            current_rank = (
                int(best_evidence.get("exactishTrackCount", 0)),
                int(best_evidence.get("strongTrackCount", 0)),
                int(best_evidence.get("matchedTrackCount", 0)),
                float(best_evidence.get("averageTrackSimilarity", 0.0)),
            )
        if rank > current_rank:
            best_album = album
            best_evidence = evidence

    return best_album, best_evidence


def main() -> None:
    parser = argparse.ArgumentParser(description="按全库标题和曲目表双重规则剔除 QQ 重复专辑")
    parser.add_argument("--input", default=str(BASE_DIR / "qq_album_need_submit.json"))
    parser.add_argument("--output", default=str(BASE_DIR / "qq_album_need_submit.json"))
    parser.add_argument("--overlap-output", default=str(BASE_DIR / "qq_album_fuzzy_overlap.json"))
    parser.add_argument("--threshold", type=float, default=0.70, help="专辑标题相似度阈值")
    parser.add_argument("--track-threshold", type=float, default=0.68, help="单曲名称视为匹配的最低相似度")
    parser.add_argument("--track-ratio", type=float, default=0.65, help="同曲目数时，至少多少比例曲目需匹配")
    parser.add_argument("--track-average", type=float, default=0.72, help="整张专辑曲目匹配的最低平均相似度")
    args = parser.parse_args()

    threshold = max(0.0, min(1.0, float(args.threshold)))
    track_threshold = max(0.0, min(1.0, float(args.track_threshold)))
    track_ratio = max(0.0, min(1.0, float(args.track_ratio)))
    track_average = max(0.0, min(1.0, float(args.track_average)))

    source = load_json(Path(args.input))
    candidates = source.get("results", []) or []

    cfg = load_json(CONFIG_FILE)
    token = get_access_token(str(cfg.get("appid") or ""), str(cfg.get("appsecret") or ""))
    env = str(cfg.get("env") or "")

    if OPENCC is None:
        print("⚠️ 未安装 OpenCC：简繁体统一将不完整。建议先运行：pip3 install opencc-python-reimplemented")

    print(f"读取候选 {len(candidates)} 张；开始拉取现存小程序完整专辑库……")
    catalog = fetch_catalog(token, env)
    if not catalog:
        raise SystemExit("错误：小程序专辑库读取为 0 张。本次不会覆盖候选文件。")

    normalized_catalog = [
        (album, normalize_title(str(album.get("title") or "")))
        for album in catalog
        if str(album.get("title") or "").strip()
    ]
    catalog_with_tracks: list[tuple[dict[str, Any], list[str]]] = []
    for album in catalog:
        tracks = extract_existing_tracks(album)
        if tracks:
            catalog_with_tracks.append((album, tracks))

    candidate_with_tracks = sum(1 for item in candidates if extract_candidate_tracks(item))
    print(f"  小程序库中 {len(catalog_with_tracks)} 张专辑含 tracks；当前候选中 {candidate_with_tracks}/{len(candidates)} 张含 tracks")

    kept: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    title_removed = 0
    track_removed = 0
    no_candidate_tracks = 0

    for idx, item in enumerate(candidates, 1):
        candidate_title = str(item.get("title") or "")
        candidate_norm = normalize_title(candidate_title)
        best_album: dict[str, Any] | None = None
        best_score = 0.0

        for album, album_norm in normalized_catalog:
            score = similarity(candidate_norm, album_norm)
            if score > best_score:
                best_score = score
                best_album = album
                if best_score >= 1.0:
                    break

        if best_album is not None and best_score >= threshold:
            title_removed += 1
            removed.append({
                **item,
                "matchedExistingAlbumId": best_album.get("_id"),
                "matchedExistingTitle": best_album.get("title"),
                "matchedExistingReleaseDate": best_album.get("releaseDate") or "",
                "titleSimilarity": round(best_score, 4),
                "filterReason": f"现存小程序专辑库存在标题相似度 {best_score:.0%} 的专辑",
                "filteredBy": "global_title_similarity",
            })
        else:
            candidate_tracks = extract_candidate_tracks(item)
            if not candidate_tracks:
                no_candidate_tracks += 1
                kept.append(item)
            else:
                matched_album, evidence = best_tracklist_match(
                    candidate_tracks,
                    catalog_with_tracks,
                    track_threshold,
                    track_ratio,
                    track_average,
                )
                if matched_album is not None and evidence is not None:
                    track_removed += 1
                    removed.append({
                        **item,
                        "matchedExistingAlbumId": matched_album.get("_id"),
                        "matchedExistingTitle": matched_album.get("title"),
                        "matchedExistingReleaseDate": matched_album.get("releaseDate") or "",
                        **evidence,
                        "filterReason": (
                            f"曲目数量同为 {evidence['trackCount']} 首；"
                            f"{evidence['matchedTrackCount']} 首达到基础匹配，"
                            f"{evidence['strongTrackCount']} 首强匹配，平均相似度 {evidence['averageTrackSimilarity']:.0%}"
                        ),
                        "filteredBy": "global_tracklist_similarity_aggressive",
                    })
                else:
                    kept.append(item)

        if idx % 50 == 0 or idx == len(candidates):
            print(
                f"  最终查重 {idx}/{len(candidates)} · "
                f"标题剔除 {title_removed} · 曲目剔除 {track_removed} · 保留 {len(kept)}"
            )

    Path(args.output).write_text(
        json.dumps({"source": "qq_album_need_submit_final_pruned", "count": len(kept), "results": kept}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    Path(args.overlap_output).write_text(
        json.dumps(
            {
                "source": "qq_album_fuzzy_overlap",
                "count": len(removed),
                "titleThreshold": threshold,
                "trackThreshold": track_threshold,
                "trackRatio": track_ratio,
                "trackAverage": track_average,
                "results": removed,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print("\n完成")
    print(f"标题 >= {threshold:.0%} 相似度剔除: {title_removed}")
    print(f"同曲目数 + 曲目表匹配剔除:    {track_removed}")
    print(f"候选中无 tracks、无法曲目查重: {no_candidate_tracks}")
    print(f"总剔除:                      {len(removed)} -> {args.overlap_output}")
    print(f"最终剩余需要提交:            {len(kept)} -> {args.output}")


if __name__ == "__main__":
    main()
