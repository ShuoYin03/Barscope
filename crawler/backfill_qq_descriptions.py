#!/usr/bin/env python3
"""Backfill missing QQ Music album descriptions into Soundive albums/candidates.

Usage:
  python3 backfill_qq_descriptions.py --dry-run
  python3 backfill_qq_descriptions.py
  python3 backfill_qq_descriptions.py --albums-only

The script only writes `description` and QQ description audit metadata. Existing non-empty
Soundive descriptions are preserved unless `--overwrite` is explicitly passed.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import time
from pathlib import Path
from typing import Any

import requests

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"
QQ_ALBUM_INFO_URL = "https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg"
QQ_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    "Referer": "https://y.qq.com/",
    "Origin": "https://y.qq.com",
}


def get_token(cfg: dict[str, Any]) -> str:
    r = requests.get(
        "https://api.weixin.qq.com/cgi-bin/token",
        params={
            "grant_type": "client_credential",
            "appid": cfg.get("appid", ""),
            "secret": cfg.get("appsecret", ""),
        },
        timeout=20,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("access_token"):
        raise RuntimeError(f"获取 access_token 失败: {data}")
    return str(data["access_token"])


def invoke(token: str, env: str, payload: dict[str, Any], retries: int = 4) -> dict[str, Any]:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            r = requests.post(
                "https://api.weixin.qq.com/tcb/invokecloudfunction",
                params={"access_token": token, "env": env, "name": "manageQQAlbumBackfill"},
                json=payload,
                timeout=90,
            )
            r.raise_for_status()
            outer = r.json()
            if outer.get("errcode", 0) != 0:
                raise RuntimeError(str(outer))
            return json.loads(outer.get("resp_data", "{}"))
        except Exception as exc:
            last = exc
            if attempt + 1 >= retries:
                break
            time.sleep(1.5 * (attempt + 1))
    assert last is not None
    raise last


def fetch_all_records(token: str, env: str, collection: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        res = invoke(token, env, {"action": "list", "collection": collection, "offset": offset, "limit": 100})
        if not res.get("success"):
            raise RuntimeError(res.get("error") or "读取数据库失败")
        rows.extend(res.get("list") or [])
        offset += 100
        if offset >= int(res.get("total", 0)):
            break
    return rows


def fetch_album_detail(album_mid: str) -> dict[str, Any]:
    r = requests.get(
        QQ_ALBUM_INFO_URL,
        params={"albummid": album_mid, "format": "json", "platform": "yqq", "newsong": 1},
        headers=QQ_HEADERS,
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def find_first_field(value: Any, keys: tuple[str, ...]) -> str:
    if isinstance(value, dict):
        for key in keys:
            raw = value.get(key)
            if raw is not None and not isinstance(raw, (dict, list)) and str(raw).strip():
                return str(raw).strip()
        for child in value.values():
            found = find_first_field(child, keys)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_first_field(child, keys)
            if found:
                return found
    return ""


def clean_description(value: Any) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_description(detail: dict[str, Any]) -> tuple[str, str]:
    data = detail.get("data") if isinstance(detail.get("data"), dict) else detail
    keys = (
        "desc",
        "description",
        "album_desc",
        "albumDesc",
        "intro",
        "album_intro",
        "albumIntro",
        "brief",
    )
    if isinstance(data, dict):
        for key in keys:
            cleaned = clean_description(data.get(key))
            if cleaned:
                return cleaned, f"detail.data.{key}"
    cleaned = clean_description(find_first_field(detail, keys))
    if cleaned:
        return cleaned, "detail.recursive"
    return "", "missing"


def qq_album_mid(record: dict[str, Any]) -> str:
    platform = str(record.get("sourcePlatform") or record.get("source") or "").lower()
    return str(record.get("qqAlbumMid") or (record.get("sourceId") if platform == "qq" else "") or "").strip()


def push_updates(token: str, env: str, collection: str, updates: list[dict[str, Any]], batch_size: int = 10) -> tuple[int, int]:
    ok = fail = 0
    for i in range(0, len(updates), batch_size):
        batch = updates[i:i + batch_size]
        res = invoke(token, env, {"action": "update", "collection": collection, "updates": batch})
        ok += int(res.get("updated", 0))
        fail += int(res.get("failed", 0))
        print(f"  写入 {i + 1}-{i + len(batch)}/{len(updates)}：成功 {res.get('updated', 0)}，失败 {res.get('failed', 0)}")
        time.sleep(0.25)
    return ok, fail


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--albums-only", action="store_true")
    parser.add_argument("--overwrite", action="store_true", help="覆盖已有非空简介")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--sleep", type=float, default=0.15)
    args = parser.parse_args()

    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    token = get_token(cfg)
    env = str(cfg.get("env") or "")
    if not env:
        raise SystemExit("config.json 缺少 env")

    collections = ["albums"] if args.albums_only else ["albums", "album_candidates"]
    for collection in collections:
        records = fetch_all_records(token, env, collection)
        if args.limit:
            records = records[:args.limit]

        qq_records = [row for row in records if qq_album_mid(row)]
        print(f"\n{collection}: 找到 {len(qq_records)} 条 QQ 记录，开始补全简介…")

        updates: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []
        skipped_existing = 0
        still_missing = 0

        for idx, row in enumerate(qq_records, 1):
            existing = clean_description(row.get("description"))
            if existing and not args.overwrite:
                skipped_existing += 1
                print(f"  [{idx}/{len(qq_records)}] - {row.get('title') or ''} | 已有简介，跳过")
                continue

            mid = qq_album_mid(row)
            try:
                detail = fetch_album_detail(mid)
                description, source = extract_description(detail)
                if not description:
                    still_missing += 1
                    print(f"  [{idx}/{len(qq_records)}] △ {row.get('title') or ''} | QQ 仍无简介")
                else:
                    patch = {
                        "description": description,
                        "qqDescriptionBackfilledAt": int(time.time()),
                        "qqDescriptionSource": source,
                    }
                    updates.append({"_id": row["_id"], "patch": patch})
                    preview = description.replace("\n", " ")[:52]
                    print(f"  [{idx}/{len(qq_records)}] ✓ {row.get('title') or ''} | {source} | {preview}{'…' if len(description) > 52 else ''}")
            except Exception as exc:
                failed.append({"_id": row.get("_id"), "title": row.get("title"), "error": str(exc)})
                print(f"  [{idx}/{len(qq_records)}] ✗ {row.get('title') or ''}：{exc}")
            time.sleep(max(args.sleep, 0))

        print(f"扫描完成：待补全 {len(updates)}，已有简介跳过 {skipped_existing}，QQ 仍缺简介 {still_missing}，失败 {len(failed)}")
        if args.dry_run:
            print("未写数据库")
        elif updates:
            ok, write_fail = push_updates(token, env, collection, updates)
            print(f"{collection} 简介回填完成：成功 {ok}，抓取失败 {len(failed)}，写入失败 {write_fail}")

        if failed:
            out = BASE_DIR / f"qq_description_backfill_failed_{collection}.json"
            out.write_text(json.dumps(failed, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"失败清单：{out}")


if __name__ == "__main__":
    main()
