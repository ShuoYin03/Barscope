#!/usr/bin/env python3
"""
Barscope · 存量数据去单曲迁移脚本

从 albums_raw.json 读取已有数据，通过网易云 album detail API 获取
每张专辑的曲目数，过滤掉 trackCount < 3 的条目，输出清洗后的文件。

用法：
  python migrate_singles.py              # 分析 + 生成 albums_raw_cleaned.json
  python migrate_singles.py --dry-run   # 只打印统计，不写文件
  python migrate_singles.py --limit 50  # 只处理前 N 条（测试用）
"""

import argparse
import json
import os
import time

import requests

BASE_DIR         = os.path.dirname(os.path.abspath(__file__))
RAW_FILE         = os.path.join(BASE_DIR, "albums_raw.json")
OUTPUT_FILE      = os.path.join(BASE_DIR, "albums_raw_cleaned.json")
CACHE_FILE       = os.path.join(BASE_DIR, "_track_count_cache.json")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer":         "https://music.163.com/",
    "Accept":          "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

MIN_TRACKS = 3


def load_cache() -> dict:
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_cache(cache: dict):
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)


def get_track_count(album_id: str, cache: dict) -> int:
    """调用网易云 album detail API 获取曲目数，结果缓存到本地。"""
    if album_id in cache:
        return cache[album_id]

    try:
        resp = requests.get(
            f"https://music.163.com/api/album/{album_id}",
            headers=HEADERS,
            timeout=12,
        )
        data = resp.json()
        if data.get("code") == 200:
            songs = data.get("album", {}).get("songs") or []
            size  = data.get("album", {}).get("size") or len(songs)
            count = int(size)
            cache[album_id] = count
            return count
    except Exception as e:
        print(f"  [!] album/{album_id}: {e}")

    cache[album_id] = -1  # -1 = API error, treat as unknown
    return -1


def main():
    parser = argparse.ArgumentParser(description="Barscope 存量去单曲迁移")
    parser.add_argument("--dry-run", action="store_true", help="只分析，不写文件")
    parser.add_argument("--limit",   type=int, default=0, help="只处理前 N 条")
    args = parser.parse_args()

    if not os.path.exists(RAW_FILE):
        print(f"[!] 找不到 {RAW_FILE}")
        return

    with open(RAW_FILE, "r", encoding="utf-8") as f:
        albums = json.load(f)

    if args.limit:
        albums = albums[: args.limit]

    print(f"共 {len(albums)} 条数据，开始查询曲目数…\n")
    cache = load_cache()

    kept    = []
    removed = []
    unknown = []

    for i, a in enumerate(albums):
        source_id = a.get("sourceId", "")

        # 已有 trackCount 字段则直接用
        existing = int(a.get("trackCount") or 0)
        if existing > 0:
            count = existing
        elif source_id and a.get("source") == "netease":
            count = get_track_count(source_id, cache)
            if i % 20 == 0:
                save_cache(cache)
            time.sleep(0.3)
        else:
            count = 0  # 非网易云来源，无法查询，保留

        if count == -1:
            unknown.append(a)  # API 失败，保留但标注
            a["trackCount"] = -1
            kept.append(a)
        elif count > 0 and count < MIN_TRACKS:
            removed.append(a)
        else:
            a["trackCount"] = count
            kept.append(a)

        if (i + 1) % 50 == 0:
            print(f"  已处理 {i+1}/{len(albums)}  保留 {len(kept)}  移除 {len(removed)}")

    save_cache(cache)

    print(f"\n{'='*50}")
    print(f"  总数:   {len(albums)}")
    print(f"  保留:   {len(kept)}")
    print(f"  移除:   {len(removed)}  （trackCount < {MIN_TRACKS}）")
    print(f"  未知:   {len(unknown)}  （API 查询失败，已保留）")

    if removed:
        print(f"\n  移除的专辑示例（前10条）：")
        for a in removed[:10]:
            print(f"    [{a.get('trackCount', '?')}曲] {a['artist']} — {a['title']}")

    if not args.dry_run:
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(kept, f, ensure_ascii=False, indent=2)
        print(f"\n  ✓ 已写入 → {OUTPUT_FILE}")
        print(f"  验证无误后，用此文件替换 albums_raw.json：")
        print(f"    copy albums_raw_cleaned.json albums_raw.json")
    else:
        print("\n  [dry-run] 未写入文件")


if __name__ == "__main__":
    main()
