#!/usr/bin/env python3
"""
Beatween · 数据清洗 + 导入文件生成

收录规则：
1. 字段、年份与曲目数通过基础校验后进入清洗；
2. 爬虫会读取网易云专辑曲目。若同一张专辑中有 3 首或以上曲目
   在去除版本后缀后名称相同（例如「XXX」「XXX (伴奏版)」「XXX - Inst.」），
   该专辑不会被自动收录，而是标记 requiresManualReview，进入候选区等待人工审核；
3. 其他专辑按原有规则进入正常收录流程。
"""

import json
import os
import re
from datetime import datetime
from typing import Dict, List

import requests

BASE_DIR       = os.path.dirname(os.path.abspath(__file__))
RAW_FILE       = os.path.join(BASE_DIR, "albums_raw.json")
IMPORT_FILE    = os.path.join(BASE_DIR, "albums_import.json")
CANDIDATE_FILE = os.path.join(BASE_DIR, "albums_candidates.json")
CURRENT_YEAR   = datetime.now().year

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    "Referer": "https://music.163.com/",
    "Accept": "application/json,text/plain,*/*",
}

# Version labels that do not make a track a distinct composition.
VERSION_SUFFIX = re.compile(
    r"\s*(?:[\(\[（【].*?[\)\]）】]|[-–—:]\s*(?:伴奏|伴奏版|纯音乐|inst(?:rumental)?|instrumental|demo|remix|acapella|karaoke|beat|off\s*vocal|vocal\s*less).*)$",
    re.IGNORECASE,
)
EXTRA_VERSION_WORDS = re.compile(r"\b(?:伴奏版?|纯音乐|inst(?:rumental)?|instrumental|demo|remix|acapella|karaoke|beat|off\s*vocal|vocal\s*less)\b", re.IGNORECASE)


def normalise_track_title(title: str) -> str:
    """Collapse version labels so XXX / XXX (伴奏版) / XXX - Inst. share one key."""
    value = (title or "").strip().lower()
    value = VERSION_SUFFIX.sub("", value)
    value = EXTRA_VERSION_WORDS.sub("", value)
    value = re.sub(r"[\s\-_·•:：()（）\[\]【】]+", "", value)
    return value


def fetch_album_track_titles(source_id: str) -> List[str]:
    """Read one album's tracklist from the NetEase album endpoint; failures stay non-blocking."""
    if not source_id:
        return []
    try:
        response = requests.get(
            f"https://music.163.com/api/v1/album/{source_id}",
            headers=HEADERS,
            timeout=12,
        )
        payload = response.json()
        if payload.get("code") != 200:
            return []
        return [str(track.get("name") or "").strip() for track in (payload.get("songs") or []) if track.get("name")]
    except Exception as exc:
        print(f"  [!] track rule check failed for album {source_id}: {exc}")
        return []


def repeated_track_reason(source_id: str) -> Dict[str, object]:
    """Return review metadata when any normalized title appears three or more times."""
    titles = fetch_album_track_titles(source_id)
    groups: Dict[str, List[str]] = {}
    for title in titles:
        key = normalise_track_title(title)
        if key:
            groups.setdefault(key, []).append(title)

    duplicated = [values for values in groups.values() if len(values) >= 3]
    if not duplicated:
        return {}

    examples = duplicated[0]
    return {
        "requiresManualReview": True,
        "candidateReason": "同一专辑存在 3 首及以上同名/版本曲目，需人工确认是否为正式专辑",
        "duplicateTrackGroups": duplicated,
        "duplicateTrackExample": examples,
    }


def clean(raw_list: list, skip_singles_filter: bool = False) -> list:
    """Clean records and attach manual-review flags for repeated-track albums."""
    cleaned = []
    seen: set = set()

    for a in raw_list:
        title  = (a.get("title") or "").strip()
        artist = (a.get("artist") or "").strip()
        cover  = (a.get("coverUrl") or "").strip()
        year   = a.get("releaseYear") or 0

        if not title or not artist or not cover:
            continue
        if year < 1990 or year > CURRENT_YEAR:
            continue

        track_count = int(a.get("trackCount") or 0)
        if not skip_singles_filter and track_count < 3:
            continue

        key = f"{title.lower()}|||{artist.lower()}"
        if key in seen:
            continue
        seen.add(key)

        review_meta = repeated_track_reason(str(a.get("sourceId") or ""))
        cleaned.append({
            "title": title,
            "artist": artist,
            "primaryArtist": a.get("primaryArtist") or artist,
            "neteaseArtistId": a.get("neteaseArtistId") or "",
            "artistIds": a.get("artistIds") or [],
            "releaseYear": year,
            "coverUrl": cover,
            "genres": a.get("genres") or [],
            "sourceId": a.get("sourceId") or "",
            "source": a.get("source") or "netease",
            "crawlSource": a.get("crawlSource") or "",
            "avgScore": 0.0,
            "reviewCount": 0,
            "trackCount": track_count,
            **review_meta,
        })

    return cleaned


def print_stats(cleaned: list, total_raw: int):
    candidates = [a for a in cleaned if a.get("requiresManualReview")]
    print(f"\n  原始数据:  {total_raw} 张")
    print(f"  清洗后:    {len(cleaned)} 张")
    print(f"  待人工筛选: {len(candidates)} 张")
    print(f"  过滤掉:    {total_raw - len(cleaned)} 张")


def main():
    if not os.path.exists(RAW_FILE):
        print(f"[!] 找不到 {RAW_FILE}")
        print("    请先运行: python spider_netease.py --mode search")
        return

    with open(RAW_FILE, "r", encoding="utf-8") as f:
        raw = json.load(f)

    cleaned = clean(raw)
    candidates = [a for a in cleaned if a.get("requiresManualReview")]
    print_stats(cleaned, len(raw))

    with open(IMPORT_FILE, "w", encoding="utf-8") as f:
        json.dump(cleaned, f, ensure_ascii=False, indent=2)
    with open(CANDIDATE_FILE, "w", encoding="utf-8") as f:
        json.dump(candidates, f, ensure_ascii=False, indent=2)

    print(f"\n  ✓ 收录文件 → {IMPORT_FILE}")
    print(f"  ✓ 候选文件 → {CANDIDATE_FILE}")
    print("  带 requiresManualReview 的专辑会保持待审核状态，不应自动出现在正式 Discover 列表。")


if __name__ == "__main__":
    main()
