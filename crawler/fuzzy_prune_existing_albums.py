#!/usr/bin/env python3
"""Final aggressive dedupe for QQ album candidates against the live BarScope catalogue.

Rules:
1. Remove when normalized album-title similarity >= 70%.
2. Also remove when album track count matches an existing album and the track names strongly align,
   even if the album titles themselves differ.

This pass compares against the full live `albums` collection through fastCompareQQAlbums.catalogPage.
It overwrites qq_album_need_submit.json and writes all removals to qq_album_fuzzy_overlap.json.
"""

from __future__ import annotations

import argparse
import json
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
TRACK_NOISE_RE = re.compile(
    r"(?:\(|（|\[|【)\s*(?:explicit|prod\.?[^\)）\]】]*|produced by[^\)）\]】]*|remaster(?:ed)?|clean)\s*(?:\)|）|\]|】)",
    re.IGNORECASE,
)


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
    text = TRACK_NOISE_RE.sub("", text)
    text = re.sub(r"\b(?:explicit|remaster(?:ed)?|clean)\b", "", text, flags=re.IGNORECASE)
    return re.sub(r"[\s\-_·•:：()（）\[\]【】<>《》'\"“”‘’.,，。!?！？&＋+／/\\|]+", "", text)


def similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        shorter, longer = sorted((len(a), len(b)))
        if longer and shorter / longer >= 0.70:
            return max(0.90, shorter / longer)
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


def extract_candidate_tracks(item: dict[str, Any]) -> list[str]:
    rows = item.get("tracksDetailed") or item.get("tracks") or []
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


def extract_existing_tracks(album: dict[str, Any]) -> list[str]:
    rows = album.get("tracks") or []
    result: list[str] = []
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, str):
            name = row
        elif isinstance(row, dict):
            name = row.get("name") or row.get("title") or ""
        else:
            name = ""
        normalized = normalize_track(str(name))
        if normalized:
            result.append(normalized)
    return result


def greedy_track_match(candidate_tracks: list[str], existing_tracks: list[str], per_track_threshold: float) -> tuple[int, float, list[float]]:
    """Match each candidate track to one unique existing track, independent of ordering."""
    if len(candidate_tracks) != len(existing_tracks) or not candidate_tracks:
        return 0, 0.0, []

    unused = set(range(len(existing_tracks)))
    scores: list[float] = []
    for candidate in candidate_tracks:
        best_idx = None
        best_score = 0.0
        for idx in unused:
            score = similarity(candidate, existing_tracks[idx])
            if score > best_score:
                best_score = score
                best_idx = idx
        if best_idx is None:
            scores.append(0.0)
            continue
        unused.remove(best_idx)
        scores.append(best_score)

    matched_count = sum(score >= per_track_threshold for score in scores)
    average = sum(scores) / len(scores) if scores else 0.0
    return matched_count, average, scores


def best_tracklist_match(
    candidate_tracks: list[str],
    catalog_with_tracks: list[tuple[dict[str, Any], list[str]]],
    per_track_threshold: float,
    required_ratio: float,
    min_average: float,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if not candidate_tracks:
        return None, None

    best_album = None
    best_evidence = None
    candidate_count = len(candidate_tracks)

    for album, existing_tracks in catalog_with_tracks:
        if len(existing_tracks) != candidate_count:
            continue
        matched_count, average, scores = greedy_track_match(candidate_tracks, existing_tracks, per_track_threshold)
        ratio = matched_count / candidate_count if candidate_count else 0.0
        if ratio < required_ratio or average < min_average:
            continue
        evidence = {
            "matchedTrackCount": matched_count,
            "trackCount": candidate_count,
            "matchedTrackRatio": round(ratio, 4),
            "averageTrackSimilarity": round(average, 4),
            "trackSimilarityScores": [round(x, 4) for x in scores],
        }
        if best_evidence is None or (ratio, average) > (
            best_evidence["matchedTrackRatio"],
            best_evidence["averageTrackSimilarity"],
        ):
            best_album = album
            best_evidence = evidence

    return best_album, best_evidence


def main() -> None:
    parser = argparse.ArgumentParser(description="按全库标题和曲目表双重规则剔除 QQ 重复专辑")
    parser.add_argument("--input", default=str(BASE_DIR / "qq_album_need_submit.json"))
    parser.add_argument("--output", default=str(BASE_DIR / "qq_album_need_submit.json"))
    parser.add_argument("--overlap-output", default=str(BASE_DIR / "qq_album_fuzzy_overlap.json"))
    parser.add_argument("--threshold", type=float, default=0.70, help="专辑标题相似度阈值")
    parser.add_argument("--track-threshold", type=float, default=0.78, help="单曲名称视为匹配的最低相似度")
    parser.add_argument("--track-ratio", type=float, default=1.0, help="同曲目数时，至少多少比例曲目需匹配；默认全部")
    parser.add_argument("--track-average", type=float, default=0.88, help="整张专辑曲目匹配的最低平均相似度")
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
        raise SystemExit("错误：小程序专辑库读取为 0 张。请先部署最新版 fastCompareQQAlbums，再重试；本次不会覆盖候选文件。")

    normalized_catalog = [
        (album, normalize_title(str(album.get("title") or "")))
        for album in catalog
        if str(album.get("title") or "").strip()
    ]
    catalog_with_tracks = []
    albums_with_tracks = 0
    for album in catalog:
        tracks = extract_existing_tracks(album)
        if tracks:
            albums_with_tracks += 1
            catalog_with_tracks.append((album, tracks))

    print(f"  其中 {albums_with_tracks} 张专辑含可用于查重的 tracks 数据")

    kept: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    title_removed = 0
    track_removed = 0

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
                        f"曲目数量同为 {evidence['trackCount']} 首，"
                        f"且 {evidence['matchedTrackCount']}/{evidence['trackCount']} 首曲名匹配，"
                        f"平均曲名相似度 {evidence['averageTrackSimilarity']:.0%}"
                    ),
                    "filteredBy": "global_tracklist_similarity",
                })
            else:
                kept.append(item)

        if idx % 50 == 0 or idx == len(candidates):
            print(
                f"  最终查重 {idx}/{len(candidates)} · "
                f"标题剔除 {title_removed} · 曲目剔除 {track_removed} · 保留 {len(kept)}"
            )

    Path(args.output).write_text(
        json.dumps(
            {"source": "qq_album_need_submit_final_pruned", "count": len(kept), "results": kept},
            ensure_ascii=False,
            indent=2,
        ),
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
    print(f"总剔除:                      {len(removed)} -> {args.overlap_output}")
    print(f"最终剩余需要提交:            {len(kept)} -> {args.output}")


if __name__ == "__main__":
    main()
