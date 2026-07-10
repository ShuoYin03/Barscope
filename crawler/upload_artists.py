#!/usr/bin/env python3
"""
Beatween · 上传歌手元数据到云数据库 artists 集合

功能：
  1. 读取 rappers.json 中所有已知艺人（rappers 列表）
  2. 并发调用网易云 /api/v1/artist/{id} 抓取 picUrl / backgroundUrl
  3. 对每位艺人执行 upsert（按 neteaseArtistId 去重）

用法：
  cd crawler
  python upload_artists.py            # 全量上传
  python upload_artists.py --dry-run  # 只抓取，不写云端
  python upload_artists.py --id 1211046  # 单个艺人测试
"""

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

sys.stdout.reconfigure(encoding="utf-8")

from spider_netease import ne_get_artist_info   # 复用爬虫函数

CONFIG_JSON = "config.json"
BASE        = "https://api.weixin.qq.com"
WORKERS     = 8


# ── 微信 HTTP API ──────────────────────────────────────────────────────────────

def get_token(cfg: dict) -> str:
    r = requests.get(f"{BASE}/cgi-bin/token",
        params={"grant_type": "client_credential",
                "appid": cfg["appid"], "secret": cfg["appsecret"]},
        timeout=10)
    d = r.json()
    if "access_token" not in d:
        raise RuntimeError(f"token 失败: {d}")
    return d["access_token"]


def db_query(token: str, env: str, query: str) -> dict:
    r = requests.post(f"{BASE}/tcb/databasequery",
        params={"access_token": token},
        json={"env": env, "query": query}, timeout=20)
    return r.json()


def db_add(token: str, env: str, data_str: str) -> dict:
    q = f'db.collection("artists").add({{data:{data_str}}})'
    r = requests.post(f"{BASE}/tcb/databaseadd",
        params={"access_token": token},
        json={"env": env, "query": q}, timeout=15)
    return r.json()


def db_update_doc(token: str, env: str, doc_id: str, data_str: str) -> dict:
    q = f'db.collection("artists").doc("{doc_id}").update({{data:{data_str}}})'
    r = requests.post(f"{BASE}/tcb/databaseupdate",
        params={"access_token": token},
        json={"env": env, "query": q}, timeout=15)
    return r.json()


def parse_records(res: dict) -> list:
    data = res.get("data", [])
    if not data:
        return []
    return [json.loads(x) if isinstance(x, str) else x for x in data]


def json_str(obj: dict) -> str:
    """把 dict 转成微信 DB 查询语句中可用的 JSON 字符串"""
    return json.dumps(obj, ensure_ascii=False)


# ── 主流程 ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="只抓取，不上传")
    parser.add_argument("--id", dest="artist_id", help="只处理指定艺人 ID")
    args = parser.parse_args()

    with open(CONFIG_JSON, encoding="utf-8") as f:
        cfg = json.load(f)

    with open("rappers.json", encoding="utf-8") as f:
        rappers_data = json.load(f)

    rappers = rappers_data.get("rappers", [])
    rappers = [r for r in rappers if r.get("id")]

    if args.artist_id:
        target_id = int(args.artist_id)
        rappers = [r for r in rappers if r.get("id") == target_id]
        if not rappers:
            rappers = [{"name": f"id={target_id}", "id": target_id}]

    print(f"共 {len(rappers)} 位艺人，并发抓取网易云信息（{WORKERS} 线程）...\n")

    # ── Step 1：并发抓 backgroundUrl ──────────────────────────────────────────
    results: dict[int, dict] = {}

    def _fetch(rapper: dict):
        aid  = rapper["id"]
        name = rapper.get("name", "")
        info = ne_get_artist_info(aid)
        return aid, name, info

    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(_fetch, r): r for r in rappers}
        for future in as_completed(futures):
            aid, name, info = future.result()
            results[aid] = {"name": name, **info}
            done += 1
            if done % 50 == 0 or done == len(rappers):
                print(f"  {done} / {len(rappers)} 抓取完成")

    # 打印样例
    sample = [(aid, v) for aid, v in results.items() if v.get("backgroundUrl")][:3]
    print(f"\n有 backgroundUrl 的: {sum(1 for v in results.values() if v.get('backgroundUrl'))} / {len(results)}")
    for aid, v in sample:
        print(f"  {v['name']} — {v['backgroundUrl'][:60]}...")

    if args.dry_run:
        print("\n[dry-run] 未上传云端。")
        return

    # ── Step 2：查询云端已有记录 ───────────────────────────────────────────────
    token = get_token(cfg)
    env   = cfg["env"]

    print("\n查询云端已有 artists 记录...")
    existing: dict[str, str] = {}  # neteaseArtistId → _id
    offset = 0
    while True:
        q   = f'db.collection("artists").skip({offset}).limit(100).get()'
        res = db_query(token, env, q)
        batch = parse_records(res)
        if not batch:
            break
        for rec in batch:
            if rec.get("neteaseArtistId"):
                existing[str(rec["neteaseArtistId"])] = rec["_id"]
        offset += 100
        if len(batch) < 100:
            break
        time.sleep(0.1)

    print(f"云端已有 {len(existing)} 条，本次处理 {len(results)} 条\n")

    # ── Step 3：upsert ─────────────────────────────────────────────────────────
    updated = 0
    created = 0
    errors  = 0

    for i, (aid, info) in enumerate(results.items()):
        doc = {
            "neteaseArtistId": str(aid),
            "name":            info.get("name", ""),
            "picUrl":          info.get("picUrl", ""),
            "backgroundUrl":   info.get("backgroundUrl", ""),
            "briefDesc":       info.get("briefDesc", ""),
            "albumSize":       info.get("albumSize", 0),
        }
        doc_str = json_str(doc)
        sid = str(aid)

        if sid in existing:
            res = db_update_doc(token, env, existing[sid], doc_str)
            if res.get("errcode", 0) == 0:
                updated += 1
            else:
                print(f"  [!] 更新失败 {info.get('name')}: {res}")
                errors += 1
        else:
            res = db_add(token, env, doc_str)
            if res.get("errcode", 0) == 0:
                created += 1
            else:
                print(f"  [!] 创建失败 {info.get('name')}: {res}")
                errors += 1

        # 每 200 条刷新 token
        if (i + 1) % 200 == 0:
            token = get_token(cfg)
            print(f"  {i+1} / {len(results)} 已处理")

        time.sleep(0.04)

    print(f"\n完成！")
    print(f"  新建: {created}  更新: {updated}  失败: {errors}")


if __name__ == "__main__":
    main()
