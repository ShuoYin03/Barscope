#!/usr/bin/env python3
"""
Barscope · 爬虫流水线（全自动）

爬取模式由云端任务指定（管理员在小程序「爬虫」面板里选择）：
  search      全量爬取   — rappers.json 所有艺人的专辑
  add-artist  按艺人ID   — 收录指定艺人的全部专辑（param=艺人ID）
  album       按专辑ID   — 精确收录单张专辑（param=专辑ID）
  fission     裂变发现   — 已批准 rapper 的专辑 + 发现新候选（默认/定时）

流程：
  1. 同步管理员审核结果 → 更新本地 rappers.json
  2. 按模式爬取
  3. 清洗数据
  4. 上传专辑到云 DB
  5. 上传候选艺人到云 DB（fission 模式产生候选，等待管理员审核）

用法:
  python pipeline.py                              # 认领云端 pending 任务（含模式）
  python pipeline.py --dry-run                    # 只爬取+清洗，不上传
  python pipeline.py --skip-db-check --mode search          # 本地强制全量爬取
  python pipeline.py --skip-db-check --mode add-artist --param 123456
  python pipeline.py --skip-db-check --mode album --param 123456
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
    run_fission, run_search, run_add_artist, run_album,
    load_rappers, save_rappers, RAPPERS_FILE,
)
from upload import clean
from db_client import CrawlerDB

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
            res = invoke_cloud_fn(token, env, "uploadAlbums", {"albums": batch, "action": "upsert"})
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

def main(from_scheduler: bool = False):
    parser = argparse.ArgumentParser(description="Barscope 爬虫")
    parser.add_argument("--dry-run",       action="store_true", help="只爬取+清洗，不上传")
    parser.add_argument("--skip-db-check", action="store_true", help="跳过 DB pending 检查（直接运行）")
    parser.add_argument("--mode", choices=["search", "add-artist", "album", "fission", "sync"],
                        default="fission",
                        help="运行模式（仅 --skip-db-check / --dry-run 时生效；正常由云端任务指定）")
    parser.add_argument("--param", default="", help="模式参数：艺人ID 或 专辑ID")
    parser.add_argument("--max-rounds", type=int, default=2, help="裂变最大轮数（fission 模式，默认 2，深度 1 传 1）")
    parser.add_argument("--workers", type=int, default=5, help="裂变并发线程数（默认 5）")
    args = parser.parse_args() if not from_scheduler else argparse.Namespace(
        dry_run=False, skip_db_check=False, mode="fission", param="")

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

    db = CrawlerDB(cfg) if not args.dry_run else None

    # 默认模式由 CLI 指定；若认领到云端任务，则被云端任务的模式覆盖
    mode  = args.mode
    param = str(args.param or "")

    # ── DB: 认领任务 ─────────────────────────────────────────────────────────
    if db and not args.skip_db_check:
        print("━━━ 检查爬虫触发状态 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        claimed = db.claim_run()
        if not claimed:
            print("  未发现 pending 任务，退出。（如需强制运行，加 --skip-db-check）")
            return
        mode  = claimed.get("mode", "fission")
        param = str(claimed.get("param", "") or "")
        label = f"{mode} / {param}" if param else mode
        print(f"  已认领任务（模式: {label}），开始运行。")
        db.append_log(f"爬虫任务开始（模式: {label}）")

    # 校验需要 ID 的模式
    if mode in ("add-artist", "album") and not param.strip().isdigit():
        msg = f"模式 {mode} 需要数字 ID，收到: {param!r}"
        print(f"[!] {msg}")
        if db: db.fail_run(msg)
        return

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
                if db: db.fail_run(str(e))
                return

            # ── Step 1: 同步审核结果 ─────────────────────────────────────────
            print("\n━━━ Step 1：同步审核结果 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            if db: db.append_log("Step 1: 同步审核结果")
            sync_decisions(token, env)

            if mode == "sync":
                print("\n✓ 同步完成，跳过爬取。")
                if db:
                    db.append_log("同步完成")
                    db.complete_run(new_albums=0, new_candidates=0, errors=[])
                return

        # ── Step 2: 爬取 ─────────────────────────────────────────────────────
        MODE_NAMES = {
            "search":     "全量爬取",
            "add-artist": "按艺人ID",
            "album":      "按专辑ID",
            "fission":    "BFS 裂变",
        }
        mode_name = MODE_NAMES.get(mode, mode)
        print(f"\n━━━ Step 2：{mode_name}爬取 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        if db: db.append_log(f"Step 2: {mode_name}爬取开始")

        # 中止检测（节流：最多每 5 秒查一次云端 abort 标记）
        _abort_state = {"last": 0.0, "aborted": False}
        def _should_abort() -> bool:
            if not db or _abort_state["aborted"]:
                return _abort_state["aborted"]
            now = time.time()
            if now - _abort_state["last"] < 5:
                return False
            _abort_state["last"] = now
            if db.is_aborted():
                _abort_state["aborted"] = True
                return True
            return False

        rappers_data  = load_rappers()
        total_artists = len(rappers_data.get("rappers", [])) if mode in ("search", "fission") else 1
        if db: db.update_progress(total_artists=total_artists)

        if mode == "search":
            raw_albums = run_search(rappers_data.get("rappers", []), dry_run=False)
        elif mode == "add-artist":
            raw_albums = run_add_artist(int(param), dry_run=False)
        elif mode == "album":
            raw_albums = run_album(int(param), dry_run=False)
        else:  # fission
            raw_albums = run_fission(dry_run=False, should_abort=_should_abort, max_rounds=args.max_rounds, workers=args.workers)

        aborted      = _abort_state["aborted"] or bool(db and db.is_aborted())
        albums_found = len(raw_albums)

        if db:
            db.update_progress(
                total_artists=total_artists,
                processed=total_artists,
                albums_found=albums_found,
            )
            db.append_log(f"Step 2: 爬取完成，原始专辑 {albums_found} 张")

        # ── Step 3: 清洗 ─────────────────────────────────────────────────────
        print("\n━━━ Step 3：清洗 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        if db: db.append_log("Step 3: 数据清洗")
        cleaned = clean(raw_albums, skip_singles_filter=(mode == "album"))
        print(f"  原始 {len(raw_albums)} 张  →  清洗后 {len(cleaned)} 张")

        if args.dry_run:
            print("\n[dry-run] 完成，跳过上传。")
            return

        # ── Step 4: 上传专辑 ─────────────────────────────────────────────────
        print("\n━━━ Step 4：上传专辑 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        if db: db.append_log(f"Step 4: 上传 {len(cleaned)} 张专辑")
        if cleaned:
            result = upload_albums(cleaned, token, env, batch_size=batch_sz)
        else:
            result = {"inserted": 0, "updated": 0, "skipped": 0, "errors": 0}
            print("  没有新专辑需要上传")

        if result.get("errors", 0) > 0:
            errors_list.append(f"上传专辑错误: {result['errors']} 张")

        # ── Step 5: 上传候选艺人 ─────────────────────────────────────────────
        print("\n━━━ Step 5：上传候选艺人 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        if db: db.append_log("Step 5: 上传候选艺人")
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

        if db:
            if aborted:
                db.append_log(f"已中止 — 已上传专辑 {result['inserted']} 张，候选 {new_candidates} 位")
                db.abort_run(new_albums=result["inserted"], new_candidates=new_candidates)
            else:
                db.append_log(f"完成 — 新增专辑 {result['inserted']} 张，新候选 {new_candidates} 位")
                db.complete_run(
                    new_albums=result["inserted"],
                    new_candidates=new_candidates,
                    errors=errors_list,
                )

    except Exception as e:
        print(f"\n[!] 运行出错: {e}")
        if db:
            db.append_log(f"运行出错: {e}")
            db.fail_run(str(e))


if __name__ == "__main__":
    main()
