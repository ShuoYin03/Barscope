#!/usr/bin/env python3
"""Fast one-pass comparison of qq_album_candidates.json against the live BarScope album library.

Outputs three files:
- qq_album_need_submit.json       genuinely missing from albums/candidates
- qq_album_overlap.json           already exists in BarScope albums
- qq_album_already_pending.json   already exists in album_candidates

This deliberately uses a dedicated bulk-read cloud function instead of the normal upsert/dedupe
path, so 2k-3k candidates can be classified quickly without 3-5 DB round trips per album.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import requests

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"
DEFAULT_INPUT = BASE_DIR / "qq_album_candidates.json"


def get_access_token(appid: str, appsecret: str) -> str:
    r = requests.get(
        "https://api.weixin.qq.com/cgi-bin/token",
        params={"grant_type": "client_credential", "appid": appid, "secret": appsecret},
        timeout=15,
    )
    r.raise_for_status()
    data = r.json()
    token = data.get("access_token")
    if not token:
        raise RuntimeError(f"获取 access_token 失败: {data}")
    return str(token)


def invoke(token: str, env: str, batch: list[dict[str, Any]]) -> dict[str, Any]:
    r = requests.post(
        "https://api.weixin.qq.com/tcb/invokecloudfunction",
        params={"access_token": token, "env": env, "name": "fastCompareQQAlbums"},
        json={"candidates": batch},
        timeout=60,
    )
    r.raise_for_status()
    payload = r.json()
    if payload.get("errcode", 0) != 0:
        raise RuntimeError(f"云函数调用失败: {payload}")
    result = json.loads(payload.get("resp_data", "{}"))
    if not result.get("success"):
        raise RuntimeError(result.get("error") or "fastCompareQQAlbums failed")
    return result


def write_payload(path: Path, source: str, results: list[dict[str, Any]]) -> None:
    path.write_text(
        json.dumps({"source": source, "count": len(results), "results": results}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="快速比对 QQ 专辑候选和 BarScope 线上专辑库")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--need-submit-output", default=str(BASE_DIR / "qq_album_need_submit.json"))
    parser.add_argument("--overlap-output", default=str(BASE_DIR / "qq_album_overlap.json"))
    parser.add_argument("--pending-output", default=str(BASE_DIR / "qq_album_already_pending.json"))
    args = parser.parse_args()

    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    token = get_access_token(str(cfg.get("appid") or ""), str(cfg.get("appsecret") or ""))
    env = str(cfg.get("env") or "")

    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    rows = payload.get("results", []) or []
    by_key = {str(x.get("sourceKey") or f"qq:{x.get('sourceId','')}"): x for x in rows}

    need_submit: list[dict[str, Any]] = []
    overlap: list[dict[str, Any]] = []
    already_pending: list[dict[str, Any]] = []

    batch_size = max(20, min(int(args.batch_size), 200))
    batches = [rows[i:i + batch_size] for i in range(0, len(rows), batch_size)]
    print(f"读取 {len(rows)} 条 QQ 专辑候选；{len(batches)} 批，每批 {batch_size} 条")

    for index, batch in enumerate(batches, 1):
        result = invoke(token, env, batch)

        for key in result.get("newItems", []) or []:
            item = by_key.get(str(key))
            if item:
                need_submit.append(item)

        overlap.extend(result.get("matched", []) or [])
        already_pending.extend(result.get("existingCandidates", []) or [])

        print(
            f"[{index}/{len(batches)}] "
            f"需要提交 +{result.get('newCount', 0)}  "
            f"库内重合 {result.get('matchedCount', 0)}  "
            f"已在候选 {result.get('existingCandidateCount', 0)}"
        )

    write_payload(Path(args.need_submit_output), "qq_album_need_submit", need_submit)
    write_payload(Path(args.overlap_output), "qq_album_overlap", overlap)
    write_payload(Path(args.pending_output), "qq_album_already_pending", already_pending)

    print("\n完成")
    print(f"需要提交小程序: {len(need_submit)} -> {args.need_submit_output}")
    print(f"与专辑库重合:   {len(overlap)} -> {args.overlap_output}")
    print(f"已在候选区:     {len(already_pending)} -> {args.pending_output}")


if __name__ == "__main__":
    main()
