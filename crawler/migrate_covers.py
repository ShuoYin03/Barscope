#!/usr/bin/env python3
"""
Barscope · 封面图迁移脚本（并发版）
NetEase CDN → 微信云存储，8 线程并发，支持中断续传

用法：
  python migrate_covers.py            # 迁移全部
  python migrate_covers.py --limit 5  # 只迁移前5张（测试）
  python migrate_covers.py --dry-run  # 只打印，不实际操作
  python migrate_covers.py --workers 4  # 调整并发数（默认8）
"""

import argparse
import json
import os
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

# COS 并发上传限制（下载可以多线程，但 COS 写入并发太高会被切断）
_cos_sem = threading.Semaphore(3)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore
except AttributeError:
    pass

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

IMG_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Referer": "https://music.163.com/",
}

# ── Token（线程安全，带自动续期）─────────────────────────────────────────────

_token_lock  = threading.Lock()
_token_cache: dict = {"value": "", "expires_at": 0.0, "appid": "", "appsecret": ""}


def get_token() -> str:
    with _token_lock:
        now = time.time()
        if _token_cache["value"] and now < _token_cache["expires_at"] - 120:
            return _token_cache["value"]
        resp = requests.get(
            "https://api.weixin.qq.com/cgi-bin/token",
            params={
                "grant_type": "client_credential",
                "appid":      _token_cache["appid"],
                "secret":     _token_cache["appsecret"],
            },
            timeout=10,
        )
        data = resp.json()
        if "access_token" not in data:
            raise RuntimeError(f"获取 access_token 失败: {data}")
        _token_cache["value"]      = data["access_token"]
        _token_cache["expires_at"] = now + data.get("expires_in", 7200)
        return _token_cache["value"]


# ── TCB HTTP API ───────────────────────────────────────────────────────────────

def tcb(endpoint: str, body: dict) -> dict:
    token = get_token()
    resp  = requests.post(
        f"https://api.weixin.qq.com/tcb/{endpoint}?access_token={token}",
        json=body,
        timeout=30,
    )
    return resp.json()


def db_count(env: str) -> int:
    r = tcb("databasecount", {"env": env, "query": 'db.collection("albums").count()'})
    if r.get("errcode", 0) != 0:
        raise RuntimeError(f"db_count 失败: {r}")
    return r.get("count", 0)


def db_query_page(env: str, skip: int, limit: int = 100) -> list:
    query = (
        f'db.collection("albums")'
        f'.field({{_id:true,sourceId:true,coverUrl:true,title:true}})'
        f'.skip({skip}).limit({limit}).get()'
    )
    r = tcb("databasequery", {"env": env, "query": query})
    if r.get("errcode", 0) != 0:
        raise RuntimeError(f"db_query 失败: {r}")
    return [json.loads(d) for d in r.get("data", [])]


def db_update_cover(env: str, album_id: str, cloud_url: str) -> bool:
    safe = cloud_url.replace('"', '\\"')
    query = (
        f'db.collection("albums").doc("{album_id}")'
        f'.update({{data:{{coverUrl:"{safe}"}}}})'
    )
    r = tcb("databaseupdate", {"env": env, "query": query})
    return r.get("errcode", 0) == 0


# ── 云存储上传 ─────────────────────────────────────────────────────────────────

def upload_cover(env: str, cos_path: str, img_bytes: bytes) -> str:
    """
    上传图片到云存储，返回 file_id（cloud:// URL）。
    - 用信号量限制并发：最多同时 3 个 COS 写入，防止被切断
    - 失败自动重试3次，指数退避
    """
    with _cos_sem:
        last_err = None
        for attempt in range(3):
            if attempt > 0:
                time.sleep(2 ** attempt)  # 2s, 4s
            try:
                # 每次重试都重新拿上传地址（URL 可能短暂有效）
                info = tcb("uploadfile", {"env": env, "path": cos_path})
                if info.get("errcode", 0) != 0:
                    raise RuntimeError(f"uploadfile 失败: {info}")

                resp = requests.post(
                    info["url"],
                    data={
                        "key":                  cos_path,
                        "Signature":            info["authorization"],
                        "x-cos-security-token": info["token"],
                        "x-cos-meta-fileid":    info["cos_file_id"],
                    },
                    files={"file": ("cover.jpg", img_bytes, "image/jpeg")},
                    timeout=120,  # 增大超时，大图/慢网络更稳
                )
                if resp.status_code not in (200, 204):
                    raise RuntimeError(f"COS 上传失败: HTTP {resp.status_code}")
                return info["file_id"]
            except Exception as e:
                last_err = e
        raise RuntimeError(f"重试3次仍失败: {last_err}")


# ── 单张迁移（在线程里执行）──────────────────────────────────────────────────

def migrate_one(album: dict, env: str) -> str:
    """
    返回 'skip' | cloud:// URL
    抛出 RuntimeError 表示失败
    """
    cover_url = album.get("coverUrl", "")
    if not cover_url or cover_url.startswith("cloud://"):
        return "skip"

    album_id  = album["_id"]
    source_id = (album.get("sourceId") or album_id).strip()
    cos_path  = f"covers/{source_id}.jpg"

    # 1. 下载图片（最慢的一步，纯网络 I/O，完全可以并行）
    img_resp = requests.get(cover_url, headers=IMG_HEADERS, timeout=15)
    if img_resp.status_code != 200:
        raise RuntimeError(f"下载失败 HTTP {img_resp.status_code}")
    img_bytes = img_resp.content
    if len(img_bytes) < 512:
        raise RuntimeError("图片数据异常（< 512B）")

    # 2+3. 获取上传地址 + 上传 COS
    file_id = upload_cover(env, cos_path, img_bytes)

    # 4. 更新 DB
    if not db_update_cover(env, album_id, file_id):
        raise RuntimeError("DB 更新失败")

    return file_id


# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="封面图迁移：NetEase CDN → 微信云存储")
    parser.add_argument("--limit",   type=int, default=0,  help="最多处理 N 张（0=全部）")
    parser.add_argument("--workers", type=int, default=8,  help="并发线程数（默认8）")
    parser.add_argument("--dry-run", action="store_true",  help="只打印，不实际操作")
    args = parser.parse_args()

    cfg       = json.load(open(CONFIG_FILE, encoding="utf-8"))
    _token_cache["appid"]     = cfg["appid"]
    _token_cache["appsecret"] = cfg["appsecret"]
    env = cfg["env"]

    dry = args.dry_run
    print(f"\n{'[dry-run] ' if dry else ''}封面图迁移  并发={args.workers}\n")

    # Token 预热
    print("  获取 access_token ...", end=" ", flush=True)
    get_token()
    print("✓")

    # 总数
    print("  查询专辑总数 ...", end=" ", flush=True)
    total = db_count(env)
    print(f"{total} 张")

    # 分页拉取全部
    print("  拉取专辑列表 ...", end=" ", flush=True)
    all_albums: list = []
    offset = 0
    while offset < total:
        page = db_query_page(env, skip=offset, limit=100)
        if not page:
            break
        all_albums.extend(page)
        offset += len(page)
    print(f"{len(all_albums)} 张")

    # 筛选待迁移
    need = [a for a in all_albums
            if not (a.get("coverUrl") or "").startswith("cloud://")]
    done_already = len(all_albums) - len(need)

    if args.limit:
        need = need[:args.limit]

    print(f"\n  待迁移: {len(need)} 张  |  已是云存储（跳过）: {done_already} 张\n")

    if not need:
        print("  全部已迁移 ✓\n")
        return

    if dry:
        for a in need[:5]:
            print(f"  (dry) {a.get('title','?')[:30]}")
        if len(need) > 5:
            print(f"  ... 共 {len(need)} 张")
        return

    # 并发迁移
    ok_count  = 0
    err_count = 0
    counter_lock = threading.Lock()
    start_time = time.time()

    def task(album: dict) -> tuple:
        """返回 (album, result_or_error)"""
        try:
            result = migrate_one(album, env)
            return album, result, None
        except Exception as e:
            return album, None, str(e)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(task, a): a for a in need}
        done_n  = 0
        for future in as_completed(futures):
            album, result, err = future.result()
            title = (album.get("title") or "?")[:20]
            done_n += 1

            with counter_lock:
                if err:
                    err_count += 1
                    status = f"✗  {err}"
                elif result == "skip":
                    status = "已迁移，跳过"
                else:
                    ok_count += 1
                    status = "✓"

                elapsed = time.time() - start_time
                speed   = done_n / elapsed if elapsed > 0 else 0
                eta     = (len(need) - done_n) / speed if speed > 0 else 0
                print(
                    f"  [{done_n:04d}/{len(need):04d}] {title:<20}  {status}"
                    f"   {speed:.1f}张/s  ETA {int(eta)}s",
                    flush=True,
                )

    elapsed = time.time() - start_time
    print(f"""
━━━ 迁移完成 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  成功:  {ok_count}
  失败:  {err_count}
  耗时:  {elapsed:.0f}s（{ok_count / elapsed:.1f} 张/s）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
""")
    if err_count:
        print("  有失败项 → 重新运行脚本，已迁移的会自动跳过，只重试失败项。\n")


if __name__ == "__main__":
    main()
