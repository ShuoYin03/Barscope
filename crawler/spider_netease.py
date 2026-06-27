#!/usr/bin/env python3
"""
Barscope · 网易云音乐爬虫（多模式版）

模式:
  search      -- 从 rappers.json 按艺人 ID 拉取所有专辑/单曲（默认）
  playlist    -- 给定歌单 ID → 提取艺人 → 加入 rappers.json → 拉取专辑
  discover    -- 搜索说唱歌单 → 提取新艺人 → 加入 rappers.json → 拉取专辑
  add-artist  -- 给定艺人 ID → 加入 rappers.json → 拉取专辑
  album       -- 给定专辑 ID → 精确收录单张专辑（跳过过滤）
  fission     -- 从种子艺人出发，通过专辑合作关系递归扩展，直到无新艺人

用法:
  python spider_netease.py                                   # search 全部
  python spider_netease.py --mode search --rapper GAI        # 只爬指定 rapper
  python spider_netease.py --mode playlist --id 123456789
  python spider_netease.py --mode discover
  python spider_netease.py --mode add-artist --id 123456
  python spider_netease.py --mode album --id 123456
  python spider_netease.py --mode fission                    # 所有已知艺人为种子
  python spider_netease.py --mode fission --rapper GAI       # 单一种子
  python spider_netease.py --mode fission --rapper "GAI,马思唯,Higher Brothers"
  python spider_netease.py --dry-run                         # 只打印，不写文件
"""

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import requests

# Windows 控制台强制 UTF-8 输出（reconfigure 是原地修改，幂等，不会关闭底层 buffer）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore
except AttributeError:
    pass

# ── 路径 ───────────────────────────────────────────────────────────────────────

BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
RAPPERS_FILE = os.path.join(BASE_DIR, "rappers.json")
OUTPUT_FILE  = os.path.join(BASE_DIR, "albums_raw.json")

# ── 请求头 ─────────────────────────────────────────────────────────────────────

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

# discover 模式用的搜索关键词（说唱相关）
DISCOVER_KEYWORDS = [
    "中国说唱", "中文说唱", "华语说唱", "说唱歌单",
    "trap 中文", "中文hiphop", "中国hip-hop", "国语rap",
]

# 包含这些关键词的专辑跳过（节目合辑、现场等）
SKIP_TITLE_KEYWORDS = [
    "第一期", "第二期", "第三期", "第四期", "第五期",
    "第六期", "第七期", "第八期", "第九期", "第十期",
    "精选集", "合辑", "现场版", "Live", "OST", "原声",
    "巅峰对决", "新说唱", "中国有嘻哈", "说唱新世代",
]

# ── 文件 I/O ────────────────────────────────────────────────────────────────────

def load_rappers() -> dict:
    with open(RAPPERS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_rappers(data: dict):
    with open(RAPPERS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def ms_to_year(ms) -> int:
    try:
        return datetime.fromtimestamp(int(ms) / 1000).year
    except Exception:
        return 0

# ── 网易云 API ─────────────────────────────────────────────────────────────────

def ne_search_artist(name: str) -> Tuple[Optional[int], int]:
    """按名字搜索艺人，返回 (artist_id, fans_size)（优先精确匹配）"""
    try:
        resp = requests.post(
            "https://music.163.com/api/search/get",
            headers=HEADERS,
            data={"s": name, "type": "100", "limit": "10", "offset": "0"},
            timeout=12,
        )
        data = resp.json()
        if data.get("code") == 200:
            artists = data.get("result", {}).get("artists", [])
            for ar in artists:
                if ar.get("name", "").strip().lower() == name.strip().lower():
                    return ar.get("id"), ar.get("fansSize", 0)
            if artists:
                return artists[0].get("id"), artists[0].get("fansSize", 0)
    except Exception as e:
        print(f"  [!] search artist '{name}': {e}")
    return None, 0


def ne_get_artist_albums(artist_id: int, page_size: int = 50) -> Tuple[str, List[dict]]:
    """
    分页拉取艺人所有专辑/单曲/EP。
    返回 (artist_name, albums_list)
    """
    all_albums: List[dict] = []
    offset      = 0
    artist_name = ""

    while True:
        try:
            resp = requests.get(
                f"https://music.163.com/api/artist/albums/{artist_id}",
                headers=HEADERS,
                params={"limit": page_size, "offset": offset},
                timeout=12,
            )
            data = resp.json()
        except Exception as e:
            print(f"  [!] artist/albums {artist_id} offset={offset}: {e}")
            break

        if data.get("code") != 200:
            break

        if not artist_name:
            artist_name = (data.get("artist") or {}).get("name", "")

        batch = data.get("hotAlbums") or []
        all_albums.extend(batch)

        if not data.get("more", False) or len(batch) == 0:
            break

        offset += page_size
        time.sleep(0.35)

    return artist_name, all_albums


def ne_search_playlists(keyword: str, limit: int = 10) -> list:
    """搜索歌单，返回歌单列表"""
    try:
        resp = requests.post(
            "https://music.163.com/api/search/get",
            headers=HEADERS,
            data={"s": keyword, "type": "1000", "limit": str(limit), "offset": "0"},
            timeout=12,
        )
        data = resp.json()
        if data.get("code") == 200:
            return data.get("result", {}).get("playlists", [])
    except Exception as e:
        print(f"  [!] search playlists '{keyword}': {e}")
    return []


def ne_get_playlist_tracks(playlist_id) -> list:
    """拉取歌单所有曲目"""
    try:
        resp = requests.post(
            "https://music.163.com/api/playlist/detail",
            headers=HEADERS,
            data={"id": str(playlist_id)},
            timeout=12,
        )
        data = resp.json()
        if data.get("code") == 200:
            return data.get("result", {}).get("tracks", [])
    except Exception as e:
        print(f"  [!] playlist tracks {playlist_id}: {e}")
    return []


def ne_get_artist_info(artist_id: int) -> dict:
    """
    获取艺人详情：picUrl / backgroundUrl / briefDesc / albumSize。
    用于保存歌手页封面背景图。
    """
    try:
        resp = requests.get(
            f"https://music.163.com/api/v1/artist/{artist_id}",
            headers=HEADERS,
            timeout=12,
        )
        data = resp.json()
        if data.get("code") == 200:
            a = data.get("artist", {})
            pic = a.get("picUrl") or ""
            return {
                "picUrl":        pic,
                "backgroundUrl": pic,   # 网易无专属背景图字段，用 picUrl 代替
                "briefDesc":     (a.get("briefDesc") or "").strip()[:300],
                "albumSize":     a.get("albumSize") or 0,
            }
    except Exception as e:
        print(f"  [!] artist info {artist_id}: {e}")
    return {}


def ne_get_album(album_id: int) -> Optional[dict]:
    """
    按专辑 ID 拉取专辑详情，返回专辑 raw dict（含 name/artist/artists/picUrl/size）。
    与 hotAlbums[] 单项结构一致，可直接喂给 normalize_album。
    """
    try:
        # 注意：/api/album/{id} 已被风控（code -462），必须用 v1 接口
        resp = requests.get(
            f"https://music.163.com/api/v1/album/{album_id}",
            headers=HEADERS,
            timeout=12,
        )
        data = resp.json()
        if data.get("code") == 200:
            return data.get("album")
    except Exception as e:
        print(f"  [!] album {album_id}: {e}")
    return None

# ── 数据标准化 ─────────────────────────────────────────────────────────────────

def normalize_album(
    raw: dict,
    fallback_artist: str = "",
    crawl_source: str = "",
    skip_filters: bool = False,
) -> Optional[dict]:
    """
    把网易云专辑 raw dict 转成标准格式。
    raw 来自 artist/albums 接口的 hotAlbums[] 项目。
    crawl_source: 描述本条数据如何被发现，例如 "netease:search:GAI"
    skip_filters: 跳过节目合辑/单曲过滤（用于「按专辑 ID」精确收录）
    """
    title          = (raw.get("name") or "").strip()
    primary_artist = (raw.get("artist") or {}).get("name", "").strip() or fallback_artist
    artists_list   = raw.get("artists") or []
    artist_names   = [a.get("name", "").strip() for a in artists_list if a.get("name", "").strip()]
    artist         = " / ".join(artist_names) if len(artist_names) > 1 else primary_artist
    cover          = raw.get("picUrl") or raw.get("blurPicUrl") or ""
    pub_ms         = raw.get("publishTime") or 0
    year           = ms_to_year(pub_ms) if pub_ms else 0
    album_id       = str(raw.get("id", ""))
    track_count    = int(raw.get("size") or 0)

    if not title or not primary_artist or not cover:
        return None
    if not skip_filters:
        if any(kw in title for kw in SKIP_TITLE_KEYWORDS):
            return None
        if track_count < 3:
            return None

    artist_obj       = raw.get("artist") or {}
    netease_artist_id = str(artist_obj["id"]) if artist_obj.get("id") else ""

    return {
        "title":            title,
        "artist":           artist,
        "primaryArtist":    primary_artist,
        "neteaseArtistId":  netease_artist_id,
        "releaseYear":      year,
        "coverUrl":         cover,
        "genres":           [],
        "sourceId":         album_id,
        "source":           "netease",
        "crawlSource":      crawl_source,
        "avgScore":         0.0,
        "reviewCount":      0,
        "trackCount":       track_count,
    }

# ── 核心工具：拉取单个艺人专辑 ─────────────────────────────────────────────────

def fetch_albums_for_rapper(
    rapper: dict,
    seen_ids: set,
    source_mode: str = "search",
) -> Tuple[dict, List[dict]]:
    """
    给定 {name, id} 对象：
      1. 若 id 为 None，先调搜索接口解析 ID
      2. 分页拉取所有专辑/单曲
      3. 每张专辑写入 crawlSource = "netease:{source_mode}:{artist_name}"
    返回 (updated_rapper_dict, new_albums_list)
    """
    name   = rapper.get("name", "").strip()
    art_id = rapper.get("id")

    # 解析艺人 ID
    if not art_id:
        art_id, _ = ne_search_artist(name)
        if not art_id:
            return {"name": name, "id": None, "netease_name": name}, []
        time.sleep(0.3)

    # 拉取所有专辑
    found_name, raw_list = ne_get_artist_albums(art_id)
    display_name = found_name or name
    crawl_source = f"netease:{source_mode}:{display_name}"

    new_albums: List[dict] = []
    for raw in raw_list:
        album = normalize_album(
            raw,
            fallback_artist=display_name,
            crawl_source=crawl_source,
        )
        if album and album["sourceId"] not in seen_ids:
            seen_ids.add(album["sourceId"])
            new_albums.append(album)

    return {"name": name, "id": art_id, "netease_name": display_name}, new_albums

# ── 文件合并工具 ────────────────────────────────────────────────────────────────

def merge_and_save_albums(new_albums: list, dry_run: bool = False) -> list:
    """把新专辑追加到 albums_raw.json，返回合并后的完整列表"""
    existing: list = []
    if os.path.exists(OUTPUT_FILE):
        with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
            existing = json.load(f)

    existing_ids = {a["sourceId"] for a in existing}
    truly_new    = [a for a in new_albums if a["sourceId"] not in existing_ids]
    merged       = existing + truly_new

    print(f"\n  已有 {len(existing)} 张  +  本次新增 {len(truly_new)} 张  =  共 {len(merged)} 张")

    if not dry_run:
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
        print(f"  已保存 → {OUTPUT_FILE}")

    return merged

# ── 模式 1：search ──────────────────────────────────────────────────────────────

def run_search(
    rappers_objs: list,
    target_name:  str  = "",
    dry_run:      bool = False,
) -> List[dict]:
    """
    按艺人 ID 拉取所有专辑/单曲。
    - rappers_objs: rappers.json 中的 [{"name": ..., "id": ...}, ...] 列表
    - target_name : 若非空，只处理该名字的艺人
    - 若 id 为 null，自动搜索并回写到 rappers.json
    """
    if target_name:
        targets = [r for r in rappers_objs
                   if r.get("name", "").lower() == target_name.lower()]
        if not targets:
            targets = [{"name": target_name, "id": None}]
    else:
        targets = rappers_objs

    print(f"\n[search]  共 {len(targets)} 位艺人\n")

    all_new:  List[dict] = []
    seen_ids: set        = set()
    id_updates: Dict[str, tuple] = {}  # original_name → (resolved_id, netease_name)

    for i, rapper in enumerate(targets, 1):
        name = rapper.get("name", "?")
        print(f"  [{i:02d}/{len(targets):02d}] {name} ...", end=" ", flush=True)

        updated, albums = fetch_albums_for_rapper(rapper, seen_ids, source_mode="search")

        if updated["id"] is None:
            print("✗  未找到艺人")
        else:
            print(f"✓  {len(albums)} 张  (id={updated['id']})")
            all_new.extend(albums)
            if rapper.get("id") is None:
                id_updates[name] = (updated["id"], updated.get("netease_name", name))

        time.sleep(0.4)

    # 回写新解析到的 id 和规范名字
    if id_updates and not dry_run:
        data = load_rappers()
        changed = False
        for r in data["rappers"]:
            if r.get("id") is None and r["name"] in id_updates:
                resolved_id, netease_name = id_updates[r["name"]]
                r["id"] = resolved_id
                if netease_name and netease_name != r["name"]:
                    print(f"  [规范] 名字: {r['name']!r} → {netease_name!r}")
                    r["name"] = netease_name
                changed = True
        if changed:
            save_rappers(data)
            print(f"\n  艺人 ID + 规范名 已更新 → {RAPPERS_FILE}")

    merge_and_save_albums(all_new, dry_run=dry_run)
    return all_new

# ── 模式 2：playlist ────────────────────────────────────────────────────────────

def run_playlist(playlist_id, dry_run: bool = False) -> List[dict]:
    """
    从指定歌单提取所有艺人 → 与 rappers.json 比对 →
    新艺人加入列表 → 拉取其专辑
    """
    print(f"\n[playlist]  歌单 ID: {playlist_id}\n")

    tracks = ne_get_playlist_tracks(playlist_id)
    if not tracks:
        print("  [!] 歌单为空或请求失败")
        return []

    print(f"  歌单共 {len(tracks)} 首曲目，提取艺人...")

    data        = load_rappers()
    known_names = {r["name"].lower() for r in data["rappers"]}
    excluded    = {e.lower() for e in data.get("excluded", [])}

    # 从曲目中提取艺人（name → id 去重）
    found: Dict[str, int] = {}
    for track in tracks:
        for ar in (track.get("ar") or []):
            name   = (ar.get("name") or "").strip()
            ar_id  = ar.get("id")
            if name and ar_id and name.lower() not in excluded:
                found[name] = ar_id

    new_rappers = [
        {"name": name, "id": ar_id}
        for name, ar_id in found.items()
        if name.lower() not in known_names
    ]

    print(f"  歌单艺人共 {len(found)} 位  |  新增: {len(new_rappers)} 位\n")

    if not new_rappers:
        print("  没有新艺人，跳过。")
        return []

    for r in new_rappers:
        print(f"  + {r['name']} (id={r['id']})")

    if not dry_run:
        data["rappers"].extend(new_rappers)
        save_rappers(data)
        print(f"\n  已写入 rappers.json（新增 {len(new_rappers)} 位）")

    # 拉取新艺人的专辑
    print("\n  开始拉取专辑...\n")
    all_new:  List[dict] = []
    seen_ids: set        = set()

    for i, rapper in enumerate(new_rappers, 1):
        print(f"  [{i:02d}/{len(new_rappers):02d}] {rapper['name']} ...", end=" ", flush=True)
        _, albums = fetch_albums_for_rapper(rapper, seen_ids, source_mode="playlist")
        print(f"✓  {len(albums)} 张")
        all_new.extend(albums)
        time.sleep(0.4)

    merge_and_save_albums(all_new, dry_run=dry_run)
    return all_new

# ── 模式 3：discover ────────────────────────────────────────────────────────────

def run_discover(dry_run: bool = False) -> List[dict]:
    """
    用说唱相关关键词搜索歌单 → 提取新艺人 →
    加入 rappers.json → 拉取其专辑
    """
    print(f"\n[discover]  搜索说唱歌单，发现新艺人\n")

    data        = load_rappers()
    known_names = {r["name"].lower() for r in data["rappers"]}
    excluded    = {e.lower() for e in data.get("excluded", [])}

    found: Dict[str, int] = {}
    source_map: Dict[str, str] = {}   # 每个候选艺人来自哪个歌单

    for keyword in DISCOVER_KEYWORDS:
        print(f"  歌单搜索: '{keyword}' ...", end=" ", flush=True)
        playlists = ne_search_playlists(keyword, limit=5)
        print(f"{len(playlists)} 个")

        for pl in playlists[:3]:
            pl_id   = pl.get("id")
            pl_name = pl.get("name", "?")
            if not pl_id:
                continue
            print(f"    ↳ [{pl_name}] ...", end=" ", flush=True)
            tracks    = ne_get_playlist_tracks(pl_id)
            new_count = 0
            for track in tracks:
                for ar in (track.get("ar") or []):
                    name  = (ar.get("name") or "").strip()
                    ar_id = ar.get("id")
                    if (name and ar_id
                            and name.lower() not in known_names
                            and name.lower() not in excluded
                            and name not in found):
                        found[name]      = ar_id
                        source_map[name] = pl_name
                        new_count       += 1
            print(f"{len(tracks)} 首，新艺人 {new_count} 位")
            time.sleep(0.5)

        time.sleep(0.8)

    new_rappers = [{"name": name, "id": ar_id} for name, ar_id in found.items()]
    print(f"\n  总计发现新艺人: {len(new_rappers)} 位")

    if not new_rappers:
        print("  没有新艺人，结束。")
        return []

    for r in new_rappers:
        src = source_map.get(r["name"], "?")
        print(f"  + {r['name']} (id={r['id']})  来自《{src}》")

    if not dry_run:
        data["rappers"].extend(new_rappers)
        save_rappers(data)
        print(f"\n  已写入 rappers.json（新增 {len(new_rappers)} 位）")

    # 拉取新艺人的专辑
    print("\n  开始拉取专辑...\n")
    all_new:  List[dict] = []
    seen_ids: set        = set()

    for i, rapper in enumerate(new_rappers, 1):
        print(f"  [{i:02d}/{len(new_rappers):02d}] {rapper['name']} ...", end=" ", flush=True)
        _, albums = fetch_albums_for_rapper(rapper, seen_ids, source_mode="discover")
        print(f"✓  {len(albums)} 张")
        all_new.extend(albums)
        time.sleep(0.4)

    merge_and_save_albums(all_new, dry_run=dry_run)
    return all_new

# ── 模式 4：add-artist ──────────────────────────────────────────────────────────

def run_add_artist(artist_id: int, dry_run: bool = False) -> List[dict]:
    """
    按艺人 ID 直接加入 rappers.json，并拉取所有专辑/单曲
    """
    print(f"\n[add-artist]  艺人 ID: {artist_id}\n")

    # 用一次 artist/albums 请求拿到艺人名字
    print("  查询艺人信息...", end=" ", flush=True)
    artist_name, _ = ne_get_artist_albums(artist_id, page_size=1)

    if not artist_name:
        print(f"✗  未找到 ID={artist_id} 的艺人")
        return []

    print(f"✓  {artist_name}")

    # 检查是否已在 rappers.json
    data        = load_rappers()
    known_ids   = {r.get("id") for r in data["rappers"]}
    known_names = {r["name"].lower() for r in data["rappers"]}
    new_entry   = {"name": artist_name, "id": artist_id}

    if artist_id in known_ids or artist_name.lower() in known_names:
        print(f"  [i] {artist_name} 已在 rappers.json，跳过添加")
    else:
        print(f"  + 添加到 rappers.json: {artist_name} (id={artist_id})")
        if not dry_run:
            data["rappers"].append(new_entry)
            save_rappers(data)

    # 拉取完整专辑（带分页，page_size=1 那次不计入）
    print(f"\n  拉取所有专辑...", end=" ", flush=True)
    seen_ids: set = set()
    _, albums = fetch_albums_for_rapper(new_entry, seen_ids, source_mode="add-artist")
    print(f"✓  {len(albums)} 张")

    merge_and_save_albums(albums, dry_run=dry_run)
    return albums

# ── 模式 5：album（按专辑 ID）────────────────────────────────────────────────────

def run_album(album_id: int, dry_run: bool = False) -> List[dict]:
    """
    按专辑 ID 精确收录单张专辑（跳过节目合辑/单曲过滤）。
    不修改 rappers.json，只把这一张专辑写入 albums_raw.json。
    """
    print(f"\n[album]  专辑 ID: {album_id}\n")

    print("  查询专辑信息...", end=" ", flush=True)
    raw = ne_get_album(album_id)
    if not raw:
        print(f"✗  未找到 ID={album_id} 的专辑")
        return []

    album = normalize_album(
        raw,
        crawl_source=f"netease:album:{album_id}",
        skip_filters=True,
    )
    if not album:
        print("✗  专辑数据不完整（缺标题/艺人/封面）")
        return []

    print(f"✓  《{album['title']}》 — {album['artist']}  ({album['trackCount']} 首)")

    merge_and_save_albums([album], dry_run=dry_run)
    return [album]

# ── 模式 6：fission（裂变）──────────────────────────────────────────────────────

def run_fission(
    seed_names:   List[str] = None,
    dry_run:      bool      = False,
    max_rounds:   int       = 2,
    should_abort=None,
    workers:      int       = 5,
) -> List[dict]:
    """
    裂变爬虫：从种子艺人出发，通过专辑合作关系递归扩展。

    算法（BFS 按轮次）：
      第 N 轮种子 → 拉取专辑 → 提取专辑级合作艺人（artists 字段）
      → 过滤已知 / excluded → 写入 candidates → 成为第 N+1 轮种子
      → 重复，直到无新合作艺人或达到 max_rounds

    seed_names   : 种子艺人名字列表（None = rappers.json 里所有已知 ID 的艺人）
    max_rounds   : BFS 最大轮数（默认 2：第 1 轮=初始种子，第 2 轮=合作艺人）
    should_abort : 可选回调，返回 True 时尽快停止裂变并返回已收集的专辑
    """
    print(f"\n[fission]  裂变爬虫启动（最多 {max_rounds} 轮）\n")

    data          = load_rappers()
    # 已确认的 rapper ID（fission 开始时的快照）——只有这些人的专辑会入库
    confirmed_ids: set = {r["id"] for r in data["rappers"] if r.get("id")}

    # 全局去重集合：confirmed + candidates + excluded 都不重复加
    known_ids: set = set(confirmed_ids)
    known_ids |= {r["id"] for r in data.get("candidates", []) if r.get("id")}
    known_ids |= set(data.get("excluded_ids", []))

    excluded_names: set = {
        e.lower() for e in data.get("excluded", []) if isinstance(e, str)
    }
    seen_album_ids: set   = set()
    all_new_albums: List[dict] = []

    # ── 确定初始种子 ────────────────────────────────────────────────
    if seed_names:
        seed_set = {s.strip().lower() for s in seed_names}
        seeds = [r for r in data["rappers"]
                 if r["name"].lower() in seed_set]
        missing = seed_set - {r["name"].lower() for r in seeds}
        for m in missing:
            print(f"  [!] 种子 '{m}' 不在 rappers.json，已跳过")
    else:
        seeds = list(data["rappers"])

    if not seeds:
        print("  [!] 无有效种子艺人，退出")
        return []

    print(f"  初始种子: {len(seeds)} 位  ({', '.join(r['name'] for r in seeds[:5])}"
          f"{'...' if len(seeds) > 5 else ''})\n")

    round_num = 0
    aborted   = False

    while seeds:
        round_num += 1
        print(f"  ── 第 {round_num} 轮  ({len(seeds)} 位种子) "
              f"{'─' * max(0, 40 - len(str(len(seeds))))}")

        # id → {name, from_artist} — 本轮新发现的合作艺人
        new_collab_map: Dict[int, dict] = {}
        # original_name → (resolved_id, netease_name) — 本轮需要回写的 ID/规范名更新
        fission_updates: Dict[str, tuple] = {}

        _print_lock = threading.Lock()
        total_seeds = len(seeds)

        def _fetch_one(args):
            i, rapper = args
            orig_name = rapper["name"]
            art_id    = rapper.get("id")

            if not art_id:
                art_id, _ = ne_search_artist(orig_name)
                if not art_id:
                    with _print_lock:
                        print(f"  [{i:03d}/{total_seeds:03d}] {orig_name} ... ✗  未找到，跳过")
                    return None
                known_ids.add(art_id)

            found_name, raw_list = ne_get_artist_albums(art_id)
            display_name = found_name or orig_name

            local_update = None
            if rapper.get("id") is None or (display_name and display_name != orig_name):
                local_update = (orig_name, art_id, display_name)

            local_albums  = []
            local_collabs = {}

            for raw in raw_list:
                if art_id in confirmed_ids:
                    album = normalize_album(
                        raw,
                        fallback_artist=display_name,
                        crawl_source=f"netease:fission:{display_name}",
                    )
                    if album:
                        local_albums.append(album)

                album_name = (raw.get("name") or "").strip()
                for collab in (raw.get("artists") or []):
                    cid   = collab.get("id")
                    cname = (collab.get("name") or "").strip()
                    if (cid and cname
                            and cid != art_id
                            and cid not in known_ids
                            and cname.lower() not in excluded_names
                            and cid not in local_collabs):
                        local_collabs[cid] = {
                            "name":      cname,
                            "from":      orig_name,
                            "fromAlbum": album_name,
                            "picUrl":    collab.get("picUrl") or collab.get("img1v1Url") or "",
                            "albumSize": collab.get("albumSize") or 0,
                        }

            with _print_lock:
                print(f"  [{i:03d}/{total_seeds:03d}] {orig_name} ... ✓  {len(raw_list)} 张  |  新合作 {len(local_collabs)} 位")

            return (art_id, local_albums, local_collabs, local_update)

        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(_fetch_one, (i, r)): i
                       for i, r in enumerate(seeds, 1)}
            for future in as_completed(futures):
                if should_abort and should_abort():
                    print("\n  [中止] 收到中止信号，停止裂变")
                    aborted = True
                    break
                result = future.result()
                if result is None:
                    continue
                art_id, local_albums, local_collabs, local_update = result

                for album in local_albums:
                    if album["sourceId"] not in seen_album_ids:
                        seen_album_ids.add(album["sourceId"])
                        all_new_albums.append(album)

                for cid, info in local_collabs.items():
                    if cid not in known_ids and cid not in new_collab_map:
                        new_collab_map[cid] = info

                if local_update:
                    orig_name, resolved_id, netease_name = local_update
                    fission_updates[orig_name] = (resolved_id, netease_name)

        # ── 回写本轮的 ID 解析 + 名字规范化 ───────────────────────────
        if fission_updates:
            changed = False
            for r in data["rappers"]:
                if r["name"] in fission_updates:
                    resolved_id, netease_name = fission_updates[r["name"]]
                    if r.get("id") is None:
                        r["id"] = resolved_id
                        known_ids.add(resolved_id)
                        changed = True
                    if netease_name and netease_name != r["name"]:
                        print(f"  [规范] 名字: {r['name']!r} → {netease_name!r}")
                        r["name"] = netease_name
                        changed = True
            if changed and not dry_run:
                save_rappers(data)
                print(f"  ID/规范名 已回写 → {RAPPERS_FILE}")

        if aborted:
            break

        if not new_collab_map:
            print(f"\n  第 {round_num} 轮无新合作艺人，裂变结束。")
            break

        # ── 补充粉丝数（并发搜索）─────────────────────────────────
        n_cands = len(new_collab_map)
        print(f"\n  补充 {n_cands} 位候选的粉丝数...", end=" ", flush=True)
        cid_list = list(new_collab_map.keys())
        def _fetch_fans(cid):
            _, fans = ne_search_artist(new_collab_map[cid]["name"])
            return cid, fans
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for cid, fans in pool.map(_fetch_fans, cid_list):
                new_collab_map[cid]["fansSize"] = fans
        print(f"✓  ({n_cands} 位)")

        # ── 打印本轮新艺人 ─────────────────────────────────────────
        new_candidates = [
            {
                "name":      info["name"],
                "id":        cid,
                "picUrl":    info.get("picUrl", ""),
                "albumSize": info.get("albumSize", 0),
                "fansSize":  info.get("fansSize", 0),
                "foundFrom": info["from"],
                "fromAlbum": info.get("fromAlbum", ""),
                "round":     round_num,
                "status":    "pending",
            }
            for cid, info in new_collab_map.items()
        ]
        print(f"\n  本轮新发现 {len(new_candidates)} 位候选艺人（→ 待审核）:")
        for c in new_candidates:
            print(f"    ? {c['name']:30s} id={c['id']:<12}  来自《{c['foundFrom']}》·《{c['fromAlbum'][:20]}》")

        # ── 写入 rappers.json candidates ──────────────────────────
        if not dry_run:
            data.setdefault("candidates", []).extend(new_candidates)
            save_rappers(data)
            print(f"  已写入 candidates（+{len(new_candidates)} 位，待管理员审核）\n")

        # 更新 known_ids，以新候选为下一轮种子继续裂变
        for c in new_candidates:
            known_ids.add(c["id"])

        if round_num >= max_rounds:
            print(f"  已达到最大轮数 {max_rounds}，裂变结束。\n")
            break

        seeds = [{"name": c["name"], "id": c["id"]} for c in new_candidates]

    # ── 汇总 ───────────────────────────────────────────────────────
    total = merge_and_save_albums(all_new_albums, dry_run=dry_run)
    print(f"""
━━━ 裂变完成 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  裂变轮数: {round_num}
  本次专辑: {len(all_new_albums)} 张
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
""")
    return all_new_albums

# ── CLI ────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Barscope 网易云爬虫（多模式）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python spider_netease.py                              # search 全部艺人
  python spider_netease.py --mode search --rapper GAI  # 只爬 GAI
  python spider_netease.py --mode playlist --id 123456789
  python spider_netease.py --mode discover
  python spider_netease.py --mode add-artist --id 12345
  python spider_netease.py --mode fission               # 全量裂变
  python spider_netease.py --mode fission --rapper GAI  # 从 GAI 开始裂变
  python spider_netease.py --dry-run                    # 只打印，不写文件
""",
    )
    parser.add_argument(
        "--mode",
        choices=["search", "playlist", "discover", "add-artist", "album", "fission"],
        default="search",
        help="运行模式（默认: search）",
    )
    parser.add_argument(
        "--rapper",
        help="[search] 只爬指定艺人；[fission] 逗号分隔的种子艺人名（空=全部）",
    )
    parser.add_argument("--id",         help="[playlist/add-artist/album] 歌单ID / 艺人ID / 专辑ID")
    parser.add_argument("--max-rounds", type=int, default=2,
                        help="[fission] BFS 最大轮数（默认 2）")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不写文件")
    args = parser.parse_args()

    data         = load_rappers()
    rappers_list = data.get("rappers", [])

    if args.mode == "search":
        if not rappers_list:
            print("rappers.json 里没有艺人，先运行 discover 或 add-artist 模式")
            return
        albums = run_search(rappers_list, target_name=args.rapper or "", dry_run=args.dry_run)
        print(f"\n  完成，本次获取 {len(albums)} 张新专辑/单曲")

    elif args.mode == "playlist":
        if not args.id:
            parser.error("--mode playlist 需要 --id <歌单ID>")
        run_playlist(args.id, dry_run=args.dry_run)

    elif args.mode == "discover":
        run_discover(dry_run=args.dry_run)

    elif args.mode == "add-artist":
        if not args.id:
            parser.error("--mode add-artist 需要 --id <艺人ID>")
        try:
            run_add_artist(int(args.id), dry_run=args.dry_run)
        except ValueError:
            print(f"[!] 艺人ID 必须是数字，收到: {args.id!r}")

    elif args.mode == "album":
        if not args.id:
            parser.error("--mode album 需要 --id <专辑ID>")
        try:
            run_album(int(args.id), dry_run=args.dry_run)
        except ValueError:
            print(f"[!] 专辑ID 必须是数字，收到: {args.id!r}")

    elif args.mode == "fission":
        seed_names = None
        if args.rapper:
            seed_names = [s.strip() for s in args.rapper.split(",") if s.strip()]
        run_fission(seed_names=seed_names, dry_run=args.dry_run,
                    max_rounds=args.max_rounds)


if __name__ == "__main__":
    main()
