#!/usr/bin/env python3
"""
Barscope · 数据清洗 + 导入文件生成

步骤：
  1. 读取 albums_raw.json（爬虫输出）
  2. 过滤：年份异常 / 字段缺失 / title+artist 重复
  3. 生成 albums_import.json（微信云DB JSON导入格式）

导入方式：
  云开发控制台 → 数据库 → albums 集合 → 导入
  → 选择 albums_import.json → 冲突处理选 Insert → 确认
"""

import json
import os
from datetime import datetime

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
RAW_FILE    = os.path.join(BASE_DIR, "albums_raw.json")
IMPORT_FILE = os.path.join(BASE_DIR, "albums_import.json")

CURRENT_YEAR = datetime.now().year


def clean(raw_list: list, skip_singles_filter: bool = False) -> list:
    """
    清洗专辑列表。
    skip_singles_filter: 跳过「单曲/EP（曲目数<3）」过滤，
                         用于「按专辑 ID」精确收录用户指定的单张专辑。
    """
    cleaned = []
    seen: set = set()

    for a in raw_list:
        title  = (a.get("title")  or "").strip()
        artist = (a.get("artist") or "").strip()
        cover  = (a.get("coverUrl") or "").strip()
        year   = a.get("releaseYear") or 0

        # 必填字段
        if not title or not artist or not cover:
            continue

        # 年份合理范围
        if year < 1990 or year > CURRENT_YEAR:
            continue

        # 过滤单曲/EP（曲目数 < 3）
        track_count = int(a.get("trackCount") or 0)
        if not skip_singles_filter and track_count < 3:
            continue

        # title+artist 去重
        key = f"{title.lower()}|||{artist.lower()}"
        if key in seen:
            continue
        seen.add(key)

        cleaned.append({
            "title":            title,
            "artist":           artist,
            "primaryArtist":    a.get("primaryArtist") or artist,
            "neteaseArtistId":  a.get("neteaseArtistId") or "",
            "releaseYear":      year,
            "coverUrl":         cover,
            "genres":           a.get("genres") or [],
            "sourceId":         a.get("sourceId") or "",
            "source":           a.get("source") or "netease",
            "crawlSource":      a.get("crawlSource") or "",
            "avgScore":         0.0,
            "reviewCount":      0,
            "trackCount":       track_count,
        })

    return cleaned


def print_stats(cleaned: list, total_raw: int):
    print(f"\n  原始数据:  {total_raw} 张")
    print(f"  清洗后:    {len(cleaned)} 张")
    print(f"  过滤掉:    {total_raw - len(cleaned)} 张")

    # 年份分布
    years: dict = {}
    for a in cleaned:
        y = a["releaseYear"]
        years[y] = years.get(y, 0) + 1

    print("\n  年份分布（近10年）：")
    for y in sorted(years.keys(), reverse=True)[:10]:
        bar = "█" * min(years[y], 25)
        print(f"    {y}: {bar} ({years[y]})")

    # 艺人 Top 10
    artists: dict = {}
    for a in cleaned:
        ar = a["artist"]
        artists[ar] = artists.get(ar, 0) + 1
    top = sorted(artists.items(), key=lambda x: x[1], reverse=True)[:10]
    print("\n  收录最多的艺人 Top 10：")
    for name, cnt in top:
        print(f"    {name}: {cnt} 张")


def main():
    if not os.path.exists(RAW_FILE):
        print(f"[!] 找不到 {RAW_FILE}")
        print("    请先运行: python spider_netease.py --mode search")
        return

    with open(RAW_FILE, "r", encoding="utf-8") as f:
        raw = json.load(f)

    cleaned = clean(raw)
    print_stats(cleaned, len(raw))
    print(f"\n  直接上传请运行: python pipeline.py（需要先配置 config.json）")

    with open(IMPORT_FILE, "w", encoding="utf-8") as f:
        json.dump(cleaned, f, ensure_ascii=False, indent=2)

    print(f"\n  ✓ 已生成 → {IMPORT_FILE}")
    print("""
  ── 导入步骤 ────────────────────────────────────────
  1. 打开云开发控制台 → 数据库 → albums 集合
  2. 点击右上角「导入」
  3. 选择文件：albums_import.json
  4. 冲突处理选「Insert」→ 确认
  ────────────────────────────────────────────────────
""")


if __name__ == "__main__":
    main()
