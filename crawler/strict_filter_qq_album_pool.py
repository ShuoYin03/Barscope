#!/usr/bin/env python3
"""Apply Soundive's strict album inclusion rules to the QQ-only submission pool.

Removes an entire album when any of these is true:
- any track is an accompaniment / instrumental / beat variant
- duplicate song titles exist in the same album after normalization
- the album is clearly an event / competition / compilation / programme release
- track-level metadata shows different lead artists across the album

Input defaults to qq_album_need_submit.json and the cleaned result overwrites that file.
Filtered albums are preserved in qq_album_filtered_out.json with explicit reasons.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent

ACCOMPANIMENT_RE = re.compile(
    r"(?:"
    r"伴奏|伴奏版|和声伴奏|纯音乐|纯伴奏|无人声|消音版|卡拉ok|卡拉OK|"
    r"\binst\.?\b|\binstrumental\b|\binstrument\s*version\b|"
    r"\bbeat\b|\bbeats\b|\bkaraoke\b|\boff\s*vocal\b|\bvocal\s*less\b"
    r")",
    re.IGNORECASE,
)

# These are not merely "high risk" in Soundive's current rule set. They are collection-style
# releases where the album owner is not the sole/main recording artist across the tracklist.
ACTIVITY_OR_COMPILATION_WORDS = [
    "地下8英里",
    "说唱者联盟",
    "大声一点hip-hop",
    "大声一点hiphop",
    "青春重置计划",
    "黑怕盲盒",
    "新说唱",
    "中国有嘻哈",
    "说唱新世代",
    "巅峰对决",
    "全国总决赛",
    "赛季总决赛",
    "赛季东部决赛",
    "赛季西部决赛",
    "赛季南部决赛",
    "赛季北部决赛",
    "合集",
    "精选集",
    "群星",
    "various artists",
    "va compilation",
]

DUPLICATE_SUFFIX_RE = re.compile(
    r"\s*[\(\[（【][^\)\]）】]*(?:explicit|version|remix|remaster(?:ed)?|deluxe|extended|live|demo)[^\)\]）】]*[\)\]）】]\s*$",
    re.IGNORECASE,
)


def load_rows(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload.get("results", []) if isinstance(payload, dict) else payload


def write_payload(path: Path, source: str, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        json.dumps({"source": source, "count": len(rows), "results": rows}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def track_name(track: Any) -> str:
    if isinstance(track, dict):
        return str(track.get("name") or track.get("title") or "").strip()
    return str(track or "").strip()


def normalize_track_title(value: str) -> str:
    value = DUPLICATE_SUFFIX_RE.sub("", str(value or "").strip().lower())
    value = re.sub(r"\bexplicit\b", "", value, flags=re.IGNORECASE)
    return re.sub(r"[\s\-_·•:：,，.!！?？'\"“”‘’()（）\[\]【】/\\]+", "", value)


def normalize_artist(value: str) -> str:
    return re.sub(r"[\s\-_·•:：()（）\[\]【】'\"“”‘’]+", "", str(value or "").strip().lower())


def track_lead_artist(track: Any) -> str:
    if not isinstance(track, dict):
        return ""
    for key in ("primaryArtist", "artistName", "artist", "singerName", "singer"):
        value = track.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key in ("artists", "singers", "artistNames"):
        value = track.get(key)
        if isinstance(value, list) and value:
            first = value[0]
            if isinstance(first, dict):
                return str(first.get("name") or first.get("artistName") or "").strip()
            return str(first).strip()
    return ""


def filter_reasons(item: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    title = str(item.get("title") or "")
    lower_title = title.lower()
    tracks = item.get("tracks") or []
    names = [track_name(t) for t in tracks if track_name(t)]

    # 1) Any accompaniment/instrumental/beat track rejects the entire album.
    accompaniment_hits = [name for name in names if ACCOMPANIMENT_RE.search(name)]
    if accompaniment_hits:
        reasons.append("含伴奏/Inst./Beat类曲目：" + "、".join(accompaniment_hits[:5]))

    # 2) Any repeated song in one album rejects the entire album.
    seen: dict[str, str] = {}
    duplicates: list[str] = []
    for name in names:
        key = normalize_track_title(name)
        if not key:
            continue
        if key in seen:
            duplicates.append(f"{seen[key]} / {name}")
        else:
            seen[key] = name
    if duplicates:
        reasons.append("同一专辑存在重复歌曲：" + "；".join(duplicates[:4]))

    # 3) Known event/competition/compilation releases are outside the album rule.
    matched_words = [word for word in ACTIVITY_OR_COMPILATION_WORDS if word.lower() in lower_title]
    if matched_words:
        reasons.append("活动/比赛/合集类专辑：" + "、".join(matched_words[:4]))

    # 4) When QQ track metadata contains lead singers, reject albums whose tracks have multiple
    # different lead artists. A normal solo album may have features, but its track primary artist
    # should remain the album owner; event/compilation releases rotate the lead artist per track.
    album_owner = normalize_artist(str(item.get("primaryArtist") or item.get("artist") or ""))
    track_artists = [track_lead_artist(t) for t in tracks]
    track_artists = [a for a in track_artists if a]
    normalized_track_artists = {normalize_artist(a) for a in track_artists if normalize_artist(a)}
    non_owner = {a for a in normalized_track_artists if a != album_owner}
    if len(normalized_track_artists) >= 2 and non_owner:
        examples = []
        seen_artist = set()
        for artist in track_artists:
            key = normalize_artist(artist)
            if key and key not in seen_artist:
                seen_artist.add(key)
                examples.append(artist)
        reasons.append("曲目主唱并非同一归属艺人，疑似活动/合集：" + "、".join(examples[:6]))

    return reasons


def write_review_csv(path: Path, items: list[dict[str, Any]]) -> None:
    fields = [
        "审核建议", "艺人", "专辑名", "曲目数", "发行日期", "QQ Album MID", "QQ Artist MID",
        "网易云 Artist ID", "Soundive Artist ID", "曲目预览", "封面",
    ]
    rows = []
    for item in items:
        names = [track_name(t) for t in (item.get("tracks") or []) if track_name(t)]
        rows.append({
            "审核建议": "建议提交",
            "艺人": item.get("artist") or item.get("primaryArtist") or "",
            "专辑名": item.get("title") or "",
            "曲目数": item.get("trackCount") or len(names),
            "发行日期": item.get("releaseDate") or "",
            "QQ Album MID": item.get("qqAlbumMid") or item.get("sourceId") or "",
            "QQ Artist MID": item.get("qqArtistMid") or "",
            "网易云 Artist ID": item.get("neteaseArtistId") or "",
            "Soundive Artist ID": item.get("barscopeArtistId") or "",
            "曲目预览": " | ".join(names[:10]),
            "封面": item.get("coverUrl") or "",
        })
    rows.sort(key=lambda row: (str(row["艺人"]).lower(), str(row["专辑名"]).lower()))
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="按 Soundive 正式收录规则严格清洗 QQ 专辑提交池")
    parser.add_argument("--input", default=str(BASE_DIR / "qq_album_need_submit.json"))
    parser.add_argument("--output", default=str(BASE_DIR / "qq_album_need_submit.json"))
    parser.add_argument("--filtered-output", default=str(BASE_DIR / "qq_album_filtered_out.json"))
    parser.add_argument("--review-csv-output", default=str(BASE_DIR / "qq_album_need_submit_review.csv"))
    args = parser.parse_args()

    rows = load_rows(Path(args.input))
    kept: list[dict[str, Any]] = []
    filtered: list[dict[str, Any]] = []
    counts: Counter = Counter()

    for item in rows:
        reasons = filter_reasons(item)
        if reasons:
            filtered.append({**item, "filterReason": "；".join(reasons), "filteredBy": "barscope_strict_album_rule"})
            if any("伴奏/Inst./Beat" in r for r in reasons): counts["伴奏"] += 1
            if any("重复歌曲" in r for r in reasons): counts["重复"] += 1
            if any("活动/比赛/合集" in r for r in reasons): counts["活动合集"] += 1
            if any("曲目主唱并非" in r for r in reasons): counts["多主唱"] += 1
        else:
            kept.append(item)

    write_payload(Path(args.output), "qq_album_need_submit", kept)
    write_payload(Path(args.filtered_output), "qq_album_filtered_out", filtered)
    write_review_csv(Path(args.review_csv_output), kept)

    print(f"输入候选:       {len(rows)}")
    print(f"规则过滤:       {len(filtered)}")
    print(f"最终可提交:     {len(kept)}")
    print(f"其中命中：伴奏 {counts['伴奏']} / 重复 {counts['重复']} / 活动合集 {counts['活动合集']} / 多主唱 {counts['多主唱']}")
    print(f"最终提交池:     {args.output}")
    print(f"人工查看表:     {args.review_csv_output}")
    print(f"被过滤明细:     {args.filtered_output}")


if __name__ == "__main__":
    main()
