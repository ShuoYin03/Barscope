#!/usr/bin/env python3
"""
Beatween · 网易云艺人数据字段诊断工具

对比已知 rapper 和 fission 误抓的非-rapper，打印所有可用字段，
帮助找出可用于过滤的信号。

用法:
  python inspect_artist.py               # 用内置样本列表
  python inspect_artist.py --id 12345    # 只看单个艺人
"""

import argparse
import json
import sys
import time

import requests

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore
except AttributeError:
    pass

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

# ── 样本艺人（已知 rapper vs fission 误抓的） ──────────────────────────────────
SAMPLES = [
    # 已知 rapper
    {"name": "GAI",        "id": 49779880, "label": "✅ rapper"},
    {"name": "马思唯",     "id": 1132392,  "label": "✅ rapper"},
    {"name": "Tizzy T",    "id": 48351573, "label": "✅ rapper"},
    {"name": "艾热",       "id": 31960441, "label": "✅ rapper"},
    {"name": "那吾克热",   "id": 12514278, "label": "✅ rapper"},
    # fission 误抓的非-rapper
    {"name": "张家辉",     "id": 6540,     "label": "❌ 非rapper（演员）"},
    {"name": "肖卓",       "id": 12338025, "label": "❌ 非rapper"},
    {"name": "祁影Sara",   "id": 36619510, "label": "❌ 非rapper"},
    {"name": "寒王",       "id": 33101497, "label": "❌ 非rapper"},
    {"name": "种一捧玫瑰", "id": 28387245, "label": "❌ 非rapper"},
    {"name": "柯镇恶",     "id": 12261311, "label": "❌ 非rapper"},
    {"name": "浪子康",     "id": 12570153, "label": "❌ 非rapper"},
]

# ── API 调用 ───────────────────────────────────────────────────────────────────

def fetch_search(name: str) -> dict:
    """艺人搜索接口（type=100），返回第一个结果的完整字段"""
    try:
        resp = requests.post(
            "https://music.163.com/api/search/get",
            headers=HEADERS,
            data={"s": name, "type": "100", "limit": "5", "offset": "0"},
            timeout=12,
        )
        data = resp.json()
        if data.get("code") == 200:
            artists = data.get("result", {}).get("artists", [])
            # 优先精确匹配，否则取第一个
            for ar in artists:
                if ar.get("name", "").strip().lower() == name.strip().lower():
                    return ar
            if artists:
                return artists[0]
    except Exception as e:
        print(f"    [!] search error: {e}")
    return {}


def fetch_artist_albums_meta(artist_id: int) -> dict:
    """artist/albums 接口返回的 artist 对象（含 briefDesc 等）"""
    try:
        resp = requests.get(
            f"https://music.163.com/api/artist/albums/{artist_id}",
            headers=HEADERS,
            params={"limit": 1, "offset": 0},
            timeout=12,
        )
        data = resp.json()
        if data.get("code") == 200:
            return data.get("artist") or {}
    except Exception as e:
        print(f"    [!] artist/albums error: {e}")
    return {}


def fetch_artist_detail(artist_id: int) -> dict:
    """artist/detail 接口（包含 identify 标签、briefDesc、videoCount 等）"""
    try:
        resp = requests.get(
            "https://music.163.com/api/artist/detail",
            headers=HEADERS,
            params={"id": artist_id},
            timeout=12,
        )
        data = resp.json()
        if data.get("code") == 200:
            return data.get("data") or {}
    except Exception as e:
        print(f"    [!] artist/detail error: {e}")
    return {}


def fetch_top_albums(artist_id: int, limit: int = 5) -> list:
    """拉取前 N 张专辑，提取 type/subType/company 字段"""
    try:
        resp = requests.get(
            f"https://music.163.com/api/artist/albums/{artist_id}",
            headers=HEADERS,
            params={"limit": limit, "offset": 0},
            timeout=12,
        )
        data = resp.json()
        if data.get("code") == 200:
            albums = data.get("hotAlbums") or []
            return [
                {
                    "name":    a.get("name"),
                    "type":    a.get("type"),
                    "subType": a.get("subType"),
                    "size":    a.get("size"),       # 曲目数
                    "company": a.get("company"),    # 发行公司
                    "artists": [x.get("name") for x in (a.get("artists") or [])],
                }
                for a in albums
            ]
    except Exception as e:
        print(f"    [!] top albums error: {e}")
    return []

# ── 诊断打印 ───────────────────────────────────────────────────────────────────

INTERESTING_SEARCH_FIELDS = [
    "id", "name", "albumSize", "musicSize", "mvSize",
    "artistType",       # 1=歌手, 2=DJ, 3=乐队, 4=..
    "briefDesc",
    "alias",
    "trans",
    "transNames",
    "identifyTag",
    "accountId",
    "followed",
]

INTERESTING_DETAIL_FIELDS = [
    "id", "name",
    "briefDesc",
    "transNames",
    "identifyTag",     # 认证标签，可能含 "说唱" 等
    "rank",
    "albumSize",
    "musicSize",
    "mvSize",
    "videoCount",
    "blacklist",
]

def print_section(title: str, data: dict, keys: list):
    print(f"  ┌─ {title}")
    for k in keys:
        v = data.get(k)
        if v not in (None, "", [], {}):
            print(f"  │  {k:<18} = {v!r}")
    # 也打印所有其他不在 keys 里但有值的字段（防漏）
    extras = {k: v for k, v in data.items() if k not in keys and v not in (None, "", [], {}, 0, False)}
    if extras:
        print(f"  │  -- 其他非空字段 --")
        for k, v in extras.items():
            # 跳过图片 URL
            if isinstance(v, str) and (v.startswith("http") and len(v) > 60):
                v = v[:60] + "..."
            if isinstance(v, dict) and len(str(v)) > 120:
                v = "{...}"
            print(f"  │  {k:<18} = {v!r}")
    print(f"  └{'─'*50}")


def inspect_artist(name: str, artist_id: int, label: str):
    sep = "═" * 60
    print(f"\n{sep}")
    print(f"  {label}  |  {name}  (id={artist_id})")
    print(sep)

    # 1. 搜索接口
    search_data = fetch_search(name)
    time.sleep(0.3)
    print_section("search /api/search/get  (type=100)", search_data, INTERESTING_SEARCH_FIELDS)

    # 2. artist/albums 里的 artist 对象
    albums_meta = fetch_artist_albums_meta(artist_id)
    time.sleep(0.3)
    print_section("artist obj  in /api/artist/albums/{id}", albums_meta, INTERESTING_SEARCH_FIELDS)

    # 3. artist/detail
    detail_data = fetch_artist_detail(artist_id)
    time.sleep(0.3)
    # detail 里有嵌套，我们展开 artist 子对象
    artist_sub = detail_data.get("artist") or {}
    identify   = detail_data.get("identify") or {}
    print_section("artist/detail → artist", artist_sub, INTERESTING_DETAIL_FIELDS)
    if identify:
        print(f"  ┌─ artist/detail → identify")
        for k, v in identify.items():
            if v not in (None, "", [], {}):
                print(f"  │  {k:<18} = {v!r}")
        print(f"  └{'─'*50}")

    # 4. 前几张专辑的 type/subType
    albums = fetch_top_albums(artist_id, limit=5)
    time.sleep(0.3)
    if albums:
        print(f"  ┌─ 前 {len(albums)} 张专辑 type/subType/company")
        for a in albums:
            name_str    = (a['name'] or '')[:30]
            artists_str = ', '.join(a['artists'])
            print(f"  │  [{a['type']}/{a['subType']}]  size={a['size']}  "
                  f"co={str(a['company'] or '')[:20]:<22}  "
                  f"{name_str}  artists={artists_str}")
        print(f"  └{'─'*50}")

    print()


# ── 主入口 ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="网易云艺人字段诊断")
    parser.add_argument("--id",   type=int, help="只看单个艺人 ID")
    parser.add_argument("--name", type=str, help="配合 --id 使用的名字标签")
    args = parser.parse_args()

    if args.id:
        name  = args.name or f"id={args.id}"
        inspect_artist(name, args.id, "🔍 自定义")
    else:
        print(f"诊断 {len(SAMPLES)} 位艺人（{sum(1 for s in SAMPLES if '✅' in s['label'])} rapper"
              f" + {sum(1 for s in SAMPLES if '❌' in s['label'])} 非rapper）\n")
        for s in SAMPLES:
            inspect_artist(s["name"], s["id"], s["label"])
            time.sleep(0.5)


if __name__ == "__main__":
    main()
