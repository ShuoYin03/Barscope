#!/usr/bin/env python3
"""
Beatween · 爬虫流水线（本地手动运行）

  fission     裂变发现   — 已批准 rapper 的专辑 + 发现新候选（默认模式）
  sync        同步决定   — 将云端审核结果同步回 rappers.json，不爬取

（全量/按艺人ID/按专辑ID的爬取改由云端 cloudCrawler 承担，本地不再重复实现）

流程：
  1. 同步管理员审核结果 → 更新本地 rappers.json
  2. 按模式爬取（fission）
  3. 清洗数据
  4. 上传专辑到云 DB
  5. 上传候选艺人到云 DB（fission 模式产生候选，等待管理员审核）

用法:
  python pipeline.py                              # fission 模式（默认）
  python pipeline.py --mode sync                  # 只同步审核结果，不爬取
  python pipeline.py --dry-run                    # 只爬取+清洗，不上传
  python pipeline.py --mode fission --max-rounds 2
"""

import argparse
import json
import os
import sys
import time

import requests

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore
except AttributeError:
    pass

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

sys.path.insert(0, BASE_DIR)
from spider_netease import (
    run_fission,
    load_rappers, save_rappers, RAPPERS_FILE,
)
from upload import clean

# ── 微信 HTTP API ──────────────────────────────────────────────────────────────

def get_access_token(appid: str, appsecret: str) -> str:
    resp = requests.get(
        "https://api.weixin.qq.com/cgi-bin/token",
        params={"grant_type": "client_credential", "appid": appid, "secret": appsecret},
        timeout=10,
    )
    data = resp.json()
    if "access_token" not in data:
        raise RuntimeError(f"获取 access_token 失败: {data}")
    print(f"  有效期: {data.get('expires_in', '?')}s")
    return data["access_token"]


def invoke_cloud_fn(token: str, env: str, name: str, body: dict) -> dict:
    resp = requests.post(
        "https://api.weixin.qq.com/tcb/invokecloudfunction",
        params={"access_token": token, "env": env, "name": name},
        json=body,
        timeout=60,
    )
    data = resp.json()
    if data.get("errcode", 0) != 0:
        raise RuntimeError(f"云函数调用失败: {data}")
    return json.loads(data.get("resp_data", "{}"))

# ── Step 1: 同步审核结果 ────────────────────────────────────────────────────────

def sync_decisions(token: str, env: str):
    print("  拉取审核结果...", end=" ", flush=True)
    try:
        res = invoke_cloud_fn(token, env, "manageCandidates", {"action": "get_decisions"})
    except Exception as e:
        print(f"✗  {e}")
        return

    approved = res.get("approved", [])
    declined = res.get("declined", [])

    if not approved and not declined:
        print("暂无新决定")
        return

    data = load_rappers()
    existing_ids = {r.get("id") for r in data["rappers"] if r.get("id")}
    approved_ids = {a["artistId"] for a in approved}
    declined_ids = {d["artistId"] for d in declined}

    added = 0
    for a in approved:
        if a["artistId"] not in existing_ids:
            data["rappers"].append({"name": a["artistName"], "id": a["artistId"]})
            existing_ids.add(a["artistId"])
            added += 1

    new_excl = declined_ids - set(data.get("excluded_ids", []))
    data.setdefault("excluded_ids", []).extend(list(new_excl))

    decided_ids = approved_ids | declined_ids
    data["candidates"] = [c for c in data.get("candidates", [])
                          if c.get("id") not in decided_ids]

    save_rappers(data)
    print(f"✓  批准 +{added} 位  拒绝 +{len(new_excl)} 个")

# ── Step 4: 上传专辑 ────────────────────────────────────────────────────────────

def upload_albums(albums: list, token: str, env: str, batch_size: int = 20) -> dict:
    total   = len(albums)
    batches = [albums[i:i+batch_size] for i in range(0, total, batch_size)]
    result  = {"inserted": 0, "updated": 0, "skipped": 0, "errors": 0}
    n       = len(batches)
    print(f"  共 {total} 张，分 {n} 批\n")
    for i, batch in enumerate(batches, 1):
        print(f"  [{i:02d}/{n:02d}] {len(batch)} 张...", end=" ", flush=True)
        try:
            res = invoke_cloud_fn(token, env, "uploadAlbums", {"albums": batch})
            result["inserted"] += res.get("inserted", 0)
            result["updated"]  += res.get("updated",  0)
            result["skipped"]  += res.get("skipped",  0)
            result["errors"]   += res.get("errors",   0)
            print(f"新增 {res.get('inserted',0)}  更新 {res.get('updated',0)}  跳过 {res.get('skipped',0)}")
        except Exception as exc:
            print(f"✗ {exc}")
            result["errors"] += len(batch)
        time.sleep(0.3)
    return result

# ── Step 5: 上传候选 ────────────────────────────────────────────────────────────

def upload_candidates(token: str, env: str, batch_size: int = 100) -> dict:
    data    = load_rappers()
    pending = [c for c in data.get("candidates", []) if c.get("status") == "pending"]
    if not pending:
        print("  候选队列为空")
        return {"inserted": 0}

    total    = len(pending)
    batches  = [pending[i:i+batch_size] for i in range(0, total, batch_size)]
    n        = len(batches)
    inserted = errors = 0
    print(f"  共 {total} 位候选，分 {n} 批\n")
    for i, batch in enumerate(batches, 1):
        print(f"  [{i:02d}/{n:02d}] {len(batch)} 位...", end=" ", flush=True)
        try:
            res = invoke_cloud_fn(token, env, "manageCandidates",
                                  {"action": "upsert_candidates", "candidates": batch})
            inserted += res.get("inserted", 0)
            print(f"新增 {res.get('inserted',0)}  重复 {res.get('skipped',0)}")
        except Exception as exc:
            print(f"✗ {exc}")
            errors += len(batch)
        time.sleep(0.3)
    return {"inserted": inserted, "errors": errors}

# ── 主流程 ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Beatween 爬虫")
    parser.add_argument("--dry-run",       action="store_true", help="只爬取+清洗，不上传")
    parser.add_argument("--mode", choices=["fission", "sync"],
                        default="fission",
                        help="运行模式（默认 fission）")
    parser.add_argument("--max-rounds", type=int, default=2, help="裂变最大轮数（fission 模式，默认 2，深度 1 传 1）")
    parser.add_argument("--workers", type=int, default=5, help="裂变并发线程数（默认 5）")
    args = parser.parse_args()

    if not os.path.exists(CONFIG_FILE):
        print("[!] 找不到 config.json")
        return

    cfg       = json.load(open(CONFIG_FILE, encoding="utf-8"))
    appid     = cfg.get("appid", "")
    appsecret = cfg.get("appsecret", "")
    env       = cfg.get("env", "")
    batch_sz  = cfg.get("batch_size", 20)

    if not appsecret or appsecret == "YOUR_APP_SECRET_HERE":
        print("[!] 请先在 config.json 填入 appsecret")
        return

    mode = args.mode
    errors_list: list = []

    try:
        # ── 获取 token（dry-run 跳过）────────────────────────────────────────
        token = None
        if not args.dry_run:
            print("━━━ 获取 access_token ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            try:
                token = get_access_token(appid, appsecret)
            except RuntimeError as e:
                print(f"  ✗ {e}")
                return

            # ── Step 1: 同步审核结果 ─────────────────────────────────────────
            print("\n━━━ Step 1：同步审核结果 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            sync_decisions(token, env)

            if mode == "sync":
                print("\n✓ 同步完成，跳过爬取。")
                return

        # ── Step 2: 爬取 ─────────────────────────────────────────────────────
        mode_name = "BFS 裂变"
        print(f"\n━━━ Step 2：{mode_name}爬取 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

        raw_albums   = run_fission(dry_run=False, max_rounds=args.max_rounds, workers=args.workers)
        albums_found = len(raw_albums)
        print(f"  爬取完成，原始专辑 {albums_found} 张")

        # ── Step 3: 清洗 ─────────────────────────────────────────────────────
        print("\n━━━ Step 3：数据清洗 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        cleaned = clean(raw_albums)
        print(f"  原始 {len(raw_albums)} 张  →  清洗后 {len(cleaned)} 张")

        if args.dry_run:
            print("\n[dry-run] 完成，跳过上传。")
            return

        # ── Step 4: 上传专辑 ─────────────────────────────────────────────────
        print("\n━━━ Step 4：上传专辑 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        if cleaned:
            result = upload_albums(cleaned, token, env, batch_size=batch_sz)
        else:
            result = {"inserted": 0, "updated": 0, "skipped": 0, "errors": 0}
            print("  没有新专辑需要上传")

        if result.get("errors", 0) > 0:
            errors_list.append(f"上传专辑错误: {result['errors']} 张")

        # ── Step 5: 上传候选艺人 ─────────────────────────────────────────────
        print("\n━━━ Step 5：上传候选艺人 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        cand_result = upload_candidates(token, env)

        new_candidates = cand_result.get("inserted", 0)

        print(f"""
━━━ 完成 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  新增专辑: {result['inserted']}
  更新专辑: {result['updated']}
  跳过:     {result['skipped']}
  错误:     {result['errors']}
  新候选:   {new_candidates}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
""")

    except Exception as e:
        print(f"\n[!] 运行出错: {e}")


if __name__ == "__main__":
    main()
