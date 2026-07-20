#!/usr/bin/env python3
"""Resolve historical Featuring Guests to canonical BarScope artist IDs.

Usage:
  python3 backfill_qq_guest_ids.py --dry-run
  python3 backfill_qq_guest_ids.py
  python3 backfill_qq_guest_ids.py --all --dry-run
  python3 backfill_qq_guest_ids.py --all
  python3 backfill_qq_guest_ids.py --albums-only --all

By default the script keeps the legacy behavior and only scans QQ-marked records.
Use --all to scan every album / album_candidate that contains unresolved guest credits.
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
    return re.sub(r"[\s\-_.·•。'\"“”‘’()（）\[\]【】/\\?!！？，,:：#]+", "", str(value or "").strip().lower())


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


def build_artist_indexes(artists: list[dict[str, Any]]) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]]]:
    by_name: dict[str, dict[str, str]] = {}
    by_qq_mid: dict[str, dict[str, str]] = {}

    for artist in artists:
        aid = str(artist.get("artistId") or artist.get("neteaseArtistId") or "").strip()
        name = str(artist.get("artistName") or artist.get("name") or "").strip()
        if not aid or not name:
            continue

        canonical = {"id": aid, "name": name}
        names = [name, artist.get("aka")]
        if isinstance(artist.get("aliases"), list):
            names += artist["aliases"]

        for candidate in names:
            key = norm(candidate)
            if key:
                by_name.setdefault(key, canonical)

        qq_values = [
            artist.get("qqArtistMid"),
            artist.get("qqArtistId"),
            artist.get("qqMid"),
        ]
        if isinstance(artist.get("platformIds"), dict):
            qq_values.append(artist["platformIds"].get("qq"))

        for value in qq_values:
            key = str(value or "").strip()
            if key:
                by_qq_mid.setdefault(key, canonical)

    return by_name, by_qq_mid


def resolve_artist_ref(
    ref: dict[str, Any],
    by_name: dict[str, dict[str, str]],
    by_qq_mid: dict[str, dict[str, str]],
) -> dict[str, Any]:
    current_id = str(ref.get("id") or "").strip()
    if current_id not in ("", "0"):
        return ref

    qq_mid = str(ref.get("qqArtistMid") or ref.get("qqArtistId") or ref.get("qqMid") or "").strip()
    hit = by_qq_mid.get(qq_mid) if qq_mid else None
    if not hit:
        hit = by_name.get(norm(ref.get("name")))
    if not hit:
        return ref

    return {**ref, "id": hit["id"], "name": hit["name"]}


def rebuild_aggregate(tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    agg: dict[str, dict[str, Any]] = {}
    for track in tracks:
        for guest in track.get("guests") or []:
            guest_id = str(guest.get("id") or "").strip()
            key = guest_id if guest_id not in ("", "0") else norm(guest.get("name"))
            if not key:
                continue
            row = agg.setdefault(
                key,
                {
                    "id": guest.get("id") or 0,
                    "name": guest.get("name") or "",
                    "count": 0,
                    "trackNos": [],
                },
            )
            row["count"] += 1
            row["trackNos"].append(track.get("no") or 0)
    return sorted(agg.values(), key=lambda x: (-x["count"], x["name"]))


def contains_unresolved_credits(row: dict[str, Any]) -> bool:
    for track in row.get("tracks") or []:
        for field in ("guests", "artists"):
            for ref in track.get(field) or []:
                if str(ref.get("id") or "").strip() in ("", "0") and str(ref.get("name") or "").strip():
                    return True
    for guest in row.get("featuringGuests") or []:
        if str(guest.get("id") or "").strip() in ("", "0") and str(guest.get("name") or "").strip():
            return True
    return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--albums-only", action="store_true")
    parser.add_argument(
        "--all",
        action="store_true",
        help="扫描全部历史专辑中未绑定 ID 的 guest / artist credits，而不只扫描 QQ 标记记录",
    )
    args = parser.parse_args()

    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    token = get_token(cfg)
    env = str(cfg.get("env") or "")
    artists = fetch_artists(token, env)
    by_name, by_qq_mid = build_artist_indexes(artists)
    print(f"已加载 {len(artists)} 位 BarScope rapper")
    print(f"名称索引 {len(by_name)} 个；QQ 身份索引 {len(by_qq_mid)} 个")

    collections = ["albums"] if args.albums_only else ["albums", "album_candidates"]
    for collection in collections:
        all_records = fetch_all(token, env, collection)
        if args.all:
            records = [r for r in all_records if contains_unresolved_credits(r)]
        else:
            records = [
                r
                for r in all_records
                if (
                    str(r.get("sourcePlatform") or r.get("source") or "").lower() == "qq"
                    or r.get("qqAlbumMid")
                )
            ]

        updates = []
        resolved_count = 0
        unresolved_names: set[str] = set()
        scanned_credit_count = 0

        for row in records:
            tracks = row.get("tracks") if isinstance(row.get("tracks"), list) else []
            changed = False
            new_tracks = []

            for track in tracks:
                new_track = dict(track)

                guests = []
                for guest in track.get("guests") or []:
                    scanned_credit_count += 1
                    original = dict(guest)
                    updated = resolve_artist_ref(original, by_name, by_qq_mid)
                    before = str(original.get("id") or "").strip()
                    after = str(updated.get("id") or "").strip()
                    if after not in ("", "0") and before in ("", "0"):
                        resolved_count += 1
                        changed = True
                    elif after in ("", "0") and updated.get("name"):
                        unresolved_names.add(str(updated["name"]))
                    guests.append(updated)

                artists_out = []
                for artist_ref in track.get("artists") or []:
                    original = dict(artist_ref)
                    updated = resolve_artist_ref(original, by_name, by_qq_mid)
                    before = str(original.get("id") or "").strip()
                    after = str(updated.get("id") or "").strip()
                    if after not in ("", "0") and before in ("", "0"):
                        changed = True
                    artists_out.append(updated)

                new_track["guests"] = guests
                new_track["artists"] = artists_out
                new_track["hasFeaturing"] = bool(guests)
                new_tracks.append(new_track)

            aggregate = rebuild_aggregate(new_tracks)
            old_aggregate = row.get("featuringGuests") if isinstance(row.get("featuringGuests"), list) else []
            if aggregate != old_aggregate:
                changed = True

            if changed:
                updates.append(
                    {
                        "_id": row["_id"],
                        "patch": {
                            "tracks": new_tracks,
                            "featuringGuests": aggregate,
                            "qqGuestIdsBackfilledAt": int(time.time()),
                        },
                    }
                )

        print(
            f"\n{collection}: 扫描记录 {len(records)} 张 / 全库 {len(all_records)} 张，"
            f"检查 guest credit {scanned_credit_count} 个，待更新 {len(updates)} 张，"
            f"成功匹配 guest credit {resolved_count} 个，仍未匹配 {len(unresolved_names)} 位"
        )
        if unresolved_names:
            print("未匹配示例：" + "、".join(sorted(unresolved_names)[:30]))
        if args.dry_run:
            print("未写数据库")
            continue

        for i in range(0, len(updates), 10):
            batch = updates[i : i + 10]
            res = invoke(token, env, {"action": "update", "collection": collection, "updates": batch})
            print(
                f"  写入 {i + 1}-{i + len(batch)}/{len(updates)}："
                f"成功 {res.get('updated', 0)}，失败 {res.get('failed', 0)}"
            )


if __name__ == "__main__":
    main()
