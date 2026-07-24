#!/usr/bin/env python3
"""Push locally resolved QQ albums into the Soundive qq_album_cache collection.

The cache is intentionally separate from album_candidates. Admins can review the cached
QQ-only additions in the mini-program's QQ Album Sync center and explicitly promote
selected rows into the normal album review queue.

Usage:
  python3 push_qq_album_cache.py
  python3 push_qq_album_cache.py --input qq_album_import_ready.json
  python3 push_qq_album_cache.py --batch-size 5
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import requests

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"
DEFAULT_INPUT = BASE_DIR / "qq_album_import_ready.json"


def get_access_token(cfg: dict[str, Any]) -> str:
    response = requests.get(
        "https://api.weixin.qq.com/cgi-bin/token",
        params={
            "grant_type": "client_credential",
            "appid": cfg.get("appid", ""),
            "secret": cfg.get("appsecret", ""),
        },
        timeout=20,
    )
    response.raise_for_status()
    payload = response.json()
    token = payload.get("access_token")
    if not token:
        raise RuntimeError(f"获取 access_token 失败: {payload}")
    return str(token)


def invoke_seed(token: str, env: str, albums: list[dict[str, Any]]) -> dict[str, Any]:
    response = requests.post(
        "https://api.weixin.qq.com/tcb/invokecloudfunction",
        params={"access_token": token, "env": env, "name": "manageQQAlbumCache"},
        json={"action": "seed", "albums": albums},
        timeout=90,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("errcode", 0) != 0:
        raise RuntimeError(f"manageQQAlbumCache 调用失败: {payload}")
    return json.loads(payload.get("resp_data", "{}"))


def invoke_seed_with_retry(
    token: str,
    env: str,
    albums: list[dict[str, Any]],
    *,
    max_retries: int = 3,
) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            return invoke_seed(token, env, albums)
        except Exception as exc:
            last_error = exc
            if attempt >= max_retries:
                break
            wait_seconds = attempt * 1.5
            print(f"    第 {attempt} 次推送失败，{wait_seconds:.1f}s 后重试：{exc}")
            time.sleep(wait_seconds)
    assert last_error is not None
    raise last_error


def main() -> None:
    parser = argparse.ArgumentParser(description="把本地 QQ 专辑解析结果推送到小程序 QQ 专辑缓存")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument(
        "--batch-size",
        type=int,
        default=5,
        help="每次调用云函数推送的专辑数。免费环境 3 秒超时，默认使用 5 张小批次。",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"找不到输入文件: {input_path}")
    if not CONFIG_FILE.exists():
        raise SystemExit(f"找不到配置文件: {CONFIG_FILE}")

    payload = json.loads(input_path.read_text(encoding="utf-8"))
    albums = payload.get("results", payload if isinstance(payload, list) else [])
    if not isinstance(albums, list):
        raise SystemExit("输入 JSON 格式不正确，需要 results 数组或直接数组")

    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    token = get_access_token(cfg)
    env = str(cfg.get("env") or "")
    if not env:
        raise SystemExit("config.json 缺少 env")

    batch_size = max(1, min(int(args.batch_size or 5), 10))
    totals = {"inserted": 0, "updated": 0, "skipped": 0}
    print(f"准备推送 {len(albums)} 张 QQ 专辑到 qq_album_cache …")
    print(f"批次大小: {batch_size}（避免云函数 3 秒超时）")

    for start in range(0, len(albums), batch_size):
        batch = albums[start:start + batch_size]
        result = invoke_seed_with_retry(token, env, batch)
        for key in totals:
            totals[key] += int(result.get(key, 0) or 0)
        print(
            f"  {start + 1}-{start + len(batch)}/{len(albums)}: "
            f"新增 {result.get('inserted', 0)}，更新 {result.get('updated', 0)}，跳过 {result.get('skipped', 0)}"
        )
        time.sleep(0.25)

    print("\nQQ 专辑缓存同步完成")
    print(f"  新增: {totals['inserted']}")
    print(f"  更新: {totals['updated']}")
    print(f"  跳过: {totals['skipped']}")
    print("\n现在可进入小程序 Admin → 专辑管理 → QQ音乐同步，选择专辑送入审核区。")


if __name__ == "__main__":
    main()
