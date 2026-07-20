#!/usr/bin/env python3
"""Resolve QQ-imported Featuring Guests to canonical BarScope artist IDs.

Usage:
  python3 backfill_qq_guest_ids.py --dry-run
  python3 backfill_qq_guest_ids.py
  python3 backfill_qq_guest_ids.py --albums-only
"""
from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path
from typing import Any

import requests

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"


def norm(value: Any) -> str:
    return re.sub(r"[\s\-_.·•。'\"“”‘’()（）\[\]【】/\\?!！？，,:：]+", "", str(value or "").strip().lower())


def get_token(cfg: dict[str, Any]) -> str:
    r = requests.get(
        "https://api.weixin.qq.com/cgi-bin/token",
        params={"grant_type": "client_credential", "appid": cfg.get("appid", ""), "secret": cfg.get("appsecret", "")},
        timeout=20,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("access_token"):
        raise RuntimeError(f"获取 access_token 失败: {data}")
    return str(data["access_token"])


def invoke(token: str, env: str, payload: dict[str, Any]) -> dict[str, Any]:
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


def fetch_all(token: str, env: str, collection: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        res = invoke(token, env, {"action": "list", "collection": collection, "offset": offset, "limit": 100})
        if not res.get("success"):
            raise RuntimeError(res.get("error") or "读取数据库失败")
        rows.extend(res.get("list") or [])
        offset += 100
        if offset >= int(res.get("total", 0)):
            return rows


def fetch_artists(token: str, env: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        res = invoke(token, env, {"action": "artists", "offset": offset, "limit": 100})
        if not res.get("success"):
            raise RuntimeError(res.get("error") or "读取 rapper 数据库失败")
        rows.extend(res.get("list") or [])
        offset += 100
        if offset >= int(res.get("total", 0)):
            return rows


def build_name_index(artists: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
    index: dict[str, dict[str, str]] = {}
    for artist in artists:
        aid = str(artist.get("artistId") or "").strip()
        name = str(artist.get("artistName") or "").strip()
        if not aid or not name:
            continue
        names = [name, artist.get("aka")]
        if isinstance(artist.get("aliases"), list):
            names += artist["aliases"]
        for candidate in names:
            key = norm(candidate)
            if key:
                index.setdefault(key, {"id": aid, "name": name})
    return index


def resolve_guest(guest: dict[str, Any], by_name: dict[str, dict[str, str]]) -> dict[str, Any]:
    if str(guest.get("id") or "").strip() not in ("", "0"):
        return guest
    hit = by_name.get(norm(guest.get("name")))
    if not hit:
        return guest
    return {**guest, "id": hit["id"], "name": hit["name"]}


def rebuild_aggregate(tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    agg: dict[str, dict[str, Any]] = {}
    for track in tracks:
        for guest in track.get("guests") or []:
            key = str(guest.get("id") or "") or norm(guest.get("name"))
            if not key:
                continue
            row = agg.setdefault(key, {"id": guest.get("id") or 0, "name": guest.get("name") or "", "count": 0, "trackNos": []})
            row["count"] += 1
            row["trackNos"].append(track.get("no") or 0)
    return sorted(agg.values(), key=lambda x: (-x["count"], x["name"]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--albums-only", action="store_true")
    args = parser.parse_args()

    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    token = get_token(cfg)
    env = str(cfg.get("env") or "")
    artists = fetch_artists(token, env)
    by_name = build_name_index(artists)
    print(f"已加载 {len(artists)} 位 BarScope rapper")

    collections = ["albums"] if args.albums_only else ["albums", "album_candidates"]
    for collection in collections:
        records = fetch_all(token, env, collection)
        records = [r for r in records if str(r.get("sourcePlatform") or r.get("source") or "").lower() == "qq" or r.get("qqAlbumMid")]
        updates = []
        resolved_count = 0
        unresolved_names: set[str] = set()

        for row in records:
            tracks = row.get("tracks") if isinstance(row.get("tracks"), list) else []
            changed = False
            new_tracks = []
            for track in tracks:
                guests = []
                for guest in (track.get("guests") or []):
                    updated = resolve_guest(dict(guest), by_name)
                    if str(updated.get("id") or "") not in ("", "0") and str(guest.get("id") or "") in ("", "0"):
                        resolved_count += 1
                        changed = True
                    elif str(updated.get("id") or "") in ("", "0") and updated.get("name"):
                        unresolved_names.add(str(updated["name"]))
                    guests.append(updated)
                new_tracks.append({**track, "guests": guests, "hasFeaturing": bool(guests)})

            aggregate = rebuild_aggregate(new_tracks)
            old_aggregate = row.get("featuringGuests") if isinstance(row.get("featuringGuests"), list) else []
            if aggregate != old_aggregate:
                changed = True
            if changed:
                updates.append({"_id": row["_id"], "patch": {"tracks": new_tracks, "featuringGuests": aggregate, "qqGuestIdsBackfilledAt": int(time.time())}})

        print(f"\n{collection}: 待更新 {len(updates)} 张，成功匹配 guest credit {resolved_count} 个，仍未匹配 {len(unresolved_names)} 位")
        if unresolved_names:
            print("未匹配示例：" + "、".join(sorted(unresolved_names)[:20]))
        if args.dry_run:
            print("未写数据库")
            continue

        for i in range(0, len(updates), 10):
            batch = updates[i:i+10]
            res = invoke(token, env, {"action": "update", "collection": collection, "updates": batch})
            print(f"  写入 {i+1}-{i+len(batch)}/{len(updates)}：成功 {res.get('updated', 0)}，失败 {res.get('failed', 0)}")


if __name__ == "__main__":
    main()
