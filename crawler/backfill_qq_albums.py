#!/usr/bin/env python3
"""Backfill every QQ-sourced BarScope album/candidate with canonical owners and QQ metadata.

What this repairs:
- canonical BarScope rapper ownership (neteaseArtistId / artistIds / ownerArtists)
- releaseDate + releaseYear
- record company / label
- full track list
- per-track featuring guests (all credited track artists minus album owners)
- aggregate featuringGuests + trackCount

The script never overwrites scores, reviews, approval state, or comments.

Usage:
  python3 backfill_qq_albums.py --dry-run
  python3 backfill_qq_albums.py
  python3 backfill_qq_albums.py --albums-only
  python3 backfill_qq_albums.py --limit 10
"""
from __future__ import annotations

import argparse
import glob
import html
import json
import re
import time
from pathlib import Path
from typing import Any

import requests

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"
MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"
LEGACY_ALBUM_INFO_URL = "https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    "Referer": "https://y.qq.com/",
    "Origin": "https://y.qq.com",
}


def norm(value: Any) -> str:
    return re.sub(r"[\s\-_.·•。'\"“”‘’()（）\[\]【】/\\?!！？，,:：]+", "", str(value or "").strip().lower()).replace("explicit", "")


def get_token(cfg: dict[str, Any]) -> str:
    r = requests.get("https://api.weixin.qq.com/cgi-bin/token", params={
        "grant_type": "client_credential", "appid": cfg.get("appid", ""), "secret": cfg.get("appsecret", "")
    }, timeout=20)
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


def fetch_all_artists(token: str, env: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        res = invoke(token, env, {"action": "artists", "offset": offset, "limit": 100})
        if not res.get("success"):
            raise RuntimeError(res.get("error") or "读取 rapper 数据库失败")
        rows.extend(res.get("list") or [])
        offset += 100
        if offset >= int(res.get("total", 0)):
            break
    return rows


def load_local_qq_mappings() -> dict[str, dict[str, str]]:
    """QQ singer MID -> canonical BarScope/NetEase artist identity from resolver output files."""
    result: dict[str, dict[str, str]] = {}
    paths = sorted(set(glob.glob(str(BASE_DIR / "qq_artist_matches*.json")) + glob.glob(str(BASE_DIR / "*artist*match*.json"))))
    for raw_path in paths:
        path = Path(raw_path)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for row in payload.get("results", []) if isinstance(payload, dict) else []:
            if row.get("resolutionStatus") not in (None, "matched"):
                continue
            best = row.get("bestCandidate") or {}
            mid = str(best.get("mid") or row.get("qqArtistMid") or "").strip()
            aid = str(row.get("neteaseArtistId") or row.get("artistId") or "").strip()
            name = str(row.get("displayName") or row.get("artistName") or best.get("name") or "").strip()
            if mid and aid:
                result[mid] = {"id": aid, "name": name}
    return result


def build_artist_indexes(artists: list[dict[str, Any]]) -> tuple[dict[str, dict], dict[str, dict]]:
    by_id: dict[str, dict] = {}
    by_name: dict[str, dict] = {}
    for a in artists:
        aid = str(a.get("artistId") or "").strip()
        name = str(a.get("artistName") or "").strip()
        if not aid or not name:
            continue
        by_id[aid] = a
        names = [name, a.get("aka")]
        names += a.get("aliases") if isinstance(a.get("aliases"), list) else []
        for n in names:
            key = norm(n)
            if key:
                by_name.setdefault(key, a)
    return by_id, by_name


def post_musicu(payload: dict[str, Any]) -> dict[str, Any]:
    r = requests.post(MUSICU_URL, json=payload, headers=HEADERS, timeout=20)
    r.raise_for_status()
    return r.json()


def album_detail(mid: str) -> dict[str, Any]:
    r = requests.get(LEGACY_ALBUM_INFO_URL, params={"albummid": mid, "format": "json", "platform": "yqq", "newsong": 1}, headers=HEADERS, timeout=20)
    r.raise_for_status()
    return r.json()


def album_tracks(mid: str) -> list[dict[str, Any]]:
    payload = {
        "comm": {"ct": 24, "cv": 0},
        "albumSongList": {
            "module": "music.musichallAlbum.AlbumSongList", "method": "GetAlbumSongList",
            "param": {"albumMid": mid, "begin": 0, "num": 500, "order": 2},
        },
    }
    rows: list[Any] = []
    try:
        raw = post_musicu(payload)
        body = (raw.get("albumSongList", {}) or {}).get("data", {}) or {}
        rows = body.get("songList") or body.get("list") or body.get("songs") or []
    except Exception:
        rows = []
    if not rows:
        detail = album_detail(mid)
        data = detail.get("data", {}) or {}
        rows = data.get("list") or data.get("songlist") or data.get("songList") or data.get("songs") or []
    out = []
    for row in rows or []:
        song = (row or {}).get("songInfo") or (row or {}).get("songinfo") or (row or {}).get("musicData") or (row or {}).get("data") or row
        if not isinstance(song, dict):
            continue
        name = str(song.get("title") or song.get("songname") or song.get("songName") or song.get("name") or "").strip()
        if not name:
            continue
        singer_rows = song.get("singer") or song.get("singerList") or song.get("singer_list") or []
        if not isinstance(singer_rows, list):
            singer_rows = [singer_rows]
        singers = []
        for s in singer_rows:
            if not isinstance(s, dict):
                continue
            sname = html.unescape(str(s.get("name") or s.get("singerName") or s.get("singer_name") or "")).strip()
            smid = str(s.get("mid") or s.get("singerMID") or s.get("singer_mid") or "").strip()
            if sname or smid:
                singers.append({"name": sname, "mid": smid})
        seconds = int(float(song.get("interval") or song.get("duration") or 0) or 0)
        out.append({"name": name, "mid": str(song.get("mid") or song.get("songmid") or song.get("songMid") or ""), "singers": singers, "duration": seconds})
    return out


def walk_find(value: Any, keys: tuple[str, ...]) -> str:
    if isinstance(value, dict):
        for k in keys:
            raw = value.get(k)
            if raw is not None and not isinstance(raw, (dict, list)) and str(raw).strip():
                return str(raw).strip()
        for child in value.values():
            found = walk_find(child, keys)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = walk_find(child, keys)
            if found:
                return found
    return ""


def release_date(detail: dict[str, Any]) -> str:
    raw = walk_find(detail, ("pub_time", "publish_date", "publishDate", "publicTime", "publictime", "release_date", "releaseDate", "time_public"))
    m = re.search(r"((?:19|20)\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})", raw)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    y = re.search(r"(?:19|20)\d{2}", raw)
    return y.group(0) if y else ""


def top_level_singers(detail: dict[str, Any]) -> list[dict[str, str]]:
    """Only album-level singer nodes; never recursively collect track artists."""
    data = detail.get("data") if isinstance(detail.get("data"), dict) else detail
    candidates: list[Any] = []
    if isinstance(data, dict):
        for key in ("singer", "singerList", "singer_list"):
            if data.get(key):
                candidates = data[key] if isinstance(data[key], list) else [data[key]]
                break
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for s in candidates:
        if not isinstance(s, dict):
            continue
        name = html.unescape(str(s.get("name") or s.get("singerName") or s.get("singer_name") or "")).strip()
        mid = str(s.get("mid") or s.get("singerMID") or s.get("singer_mid") or "").strip()
        key = mid or norm(name)
        if key and key not in seen:
            seen.add(key)
            out.append({"name": name, "mid": mid})
    return out


def resolve_owners(record: dict[str, Any], singers: list[dict[str, str]], local_map: dict[str, dict[str, str]], by_id: dict[str, dict], by_name: dict[str, dict]) -> list[dict[str, str]]:
    resolved: list[dict[str, str]] = []
    seen: set[str] = set()
    # 1) Explicit resolver map by QQ MID.
    for singer in singers:
        mid = singer.get("mid", "")
        mapped = local_map.get(mid)
        if mapped and mapped["id"] in by_id and mapped["id"] not in seen:
            a = by_id[mapped["id"]]
            resolved.append({"id": str(a["artistId"]), "name": str(a["artistName"])})
            seen.add(str(a["artistId"]))
    # 2) Canonical name / aliases.
    for singer in singers:
        hit = by_name.get(norm(singer.get("name")))
        if hit and str(hit["artistId"]) not in seen:
            resolved.append({"id": str(hit["artistId"]), "name": str(hit["artistName"])})
            seen.add(str(hit["artistId"]))
    # 3) Preserve existing canonical IDs only when they are valid BarScope rapper IDs.
    for raw_id in [record.get("neteaseArtistId"), *(record.get("artistIds") or [])]:
        aid = str(raw_id or "").strip()
        if aid in by_id and aid not in seen:
            a = by_id[aid]
            resolved.append({"id": aid, "name": str(a["artistName"])})
            seen.add(aid)
    return resolved


def aggregate_guests(tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    agg: dict[str, dict[str, Any]] = {}
    for track in tracks:
        for guest in track.get("guests", []):
            key = str(guest.get("id") or "") or norm(guest.get("name"))
            if not key:
                continue
            row = agg.setdefault(key, {"id": guest.get("id") or 0, "name": guest.get("name") or "", "count": 0, "trackNos": []})
            row["count"] += 1
            row["trackNos"].append(track["no"])
    return sorted(agg.values(), key=lambda x: (-x["count"], x["name"]))


def enrich(record: dict[str, Any], local_map: dict[str, dict[str, str]], by_id: dict[str, dict], by_name: dict[str, dict]) -> dict[str, Any]:
    mid = str(record.get("qqAlbumMid") or (record.get("sourceId") if str(record.get("sourcePlatform") or record.get("source") or "").lower() == "qq" else "") or "").strip()
    if not mid:
        raise RuntimeError("missing qqAlbumMid")
    detail = album_detail(mid)
    raw_tracks = album_tracks(mid)
    singers = top_level_singers(detail)
    if not singers:
        mids = record.get("qqArtistMids") or ([record.get("qqArtistMid")] if record.get("qqArtistMid") else [])
        names = [x.strip() for x in str(record.get("artist") or record.get("primaryArtist") or "").split("/") if x.strip()]
        singers = [{"mid": str(mids[i]) if i < len(mids) else "", "name": name} for i, name in enumerate(names)]
    owners = resolve_owners(record, singers, local_map, by_id, by_name)
    owner_names = [x["name"] for x in owners] or [x.get("name", "") for x in singers if x.get("name")]
    owner_ids = [x["id"] for x in owners]
    owner_mids = {str(x.get("mid") or "") for x in singers if x.get("mid")}
    owner_name_keys = {norm(x) for x in owner_names} | {norm(x.get("name")) for x in singers}

    tracks: list[dict[str, Any]] = []
    for i, track in enumerate(raw_tracks, 1):
        credited = [{"id": 0, "name": s.get("name", ""), "qqArtistMid": s.get("mid", "")} for s in track.get("singers", []) if s.get("name")]
        guests = []
        for artist in credited:
            if artist["qqArtistMid"] and artist["qqArtistMid"] in owner_mids:
                continue
            if norm(artist["name"]) in owner_name_keys:
                continue
            hit = local_map.get(artist["qqArtistMid"]) or None
            guest_id = str(hit.get("id")) if hit and hit.get("id") in by_id else ""
            guests.append({"id": guest_id or 0, "name": by_id[guest_id]["artistName"] if guest_id else artist["name"]})
        tracks.append({
            "no": i,
            "name": track["name"],
            "artists": [{"id": 0, "name": a["name"]} for a in credited] or [{"id": x["id"], "name": x["name"]} for x in owners],
            "guests": guests,
            "hasFeaturing": bool(guests),
            "duration": track.get("duration", 0),
            "durationMs": int(track.get("duration", 0)) * 1000,
            "qqSongMid": track.get("mid", ""),
        })

    date = release_date(detail)
    year_m = re.search(r"(?:19|20)\d{2}", date)
    company = walk_find(detail, ("company", "company_name", "companyName", "label", "record_company", "recordCompany"))
    title = walk_find(detail, ("album_name", "albumName")) or str(record.get("title") or "")
    qq_mids = [x.get("mid", "") for x in singers if x.get("mid")]
    patch = {
        "title": title,
        "artist": " / ".join(owner_names),
        "primaryArtist": owner_names[0] if owner_names else "",
        "neteaseArtistId": owner_ids[0] if owner_ids else "",
        "artistIds": owner_ids,
        "ownerArtistIds": owner_ids,
        "ownerArtists": owners,
        "qqArtistMid": qq_mids[0] if qq_mids else str(record.get("qqArtistMid") or ""),
        "qqArtistMids": qq_mids or record.get("qqArtistMids") or [],
        "releaseDate": date,
        "releaseYear": int(year_m.group(0)) if year_m else 0,
        "company": company,
        "tracks": tracks,
        "trackCount": len(tracks),
        "featuringGuests": aggregate_guests(tracks),
        "metadataCompleteness": {
            "releaseDate": bool(date), "company": bool(company), "tracks": len(tracks), "ownerArtistIds": len(owner_ids)
        },
        "qqMetadataBackfilledAt": int(time.time()),
    }
    return patch


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
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--albums-only", action="store_true")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--sleep", type=float, default=0.15)
    args = p.parse_args()

    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    token = get_token(cfg)
    env = str(cfg.get("env") or "")
    if not env:
        raise SystemExit("config.json 缺少 env")

    artists = fetch_all_artists(token, env)
    by_id, by_name = build_artist_indexes(artists)
    local_map = load_local_qq_mappings()
    print(f"已加载 {len(artists)} 位 BarScope rapper；本地 QQ MID 映射 {len(local_map)} 条")

    collections = ["albums"] if args.albums_only else ["albums", "album_candidates"]
    for collection in collections:
        records = fetch_all_records(token, env, collection)
        if args.limit:
            records = records[:args.limit]
        print(f"\n{collection}: 找到 {len(records)} 条 QQ 记录，开始补全…")
        updates = []
        failed = []
        for idx, row in enumerate(records, 1):
            try:
                patch = enrich(row, local_map, by_id, by_name)
                updates.append({"_id": row["_id"], "patch": patch})
                print(f"  [{idx}/{len(records)}] ✓ {patch['title']} | {patch['releaseDate'] or '无日期'} | {patch['trackCount']} tracks | owner={patch['artist'] or '未匹配'}")
            except Exception as exc:
                failed.append({"_id": row.get("_id"), "title": row.get("title"), "error": str(exc)})
                print(f"  [{idx}/{len(records)}] ✗ {row.get('title')}：{exc}")
            time.sleep(max(args.sleep, 0))

        if args.dry_run:
            print(f"预览完成：可更新 {len(updates)}，失败 {len(failed)}；未写数据库")
        else:
            ok, write_fail = push_updates(token, env, collection, updates)
            print(f"{collection} 回填完成：成功 {ok}，抓取失败 {len(failed)}，写入失败 {write_fail}")
        if failed:
            out = BASE_DIR / f"qq_backfill_failed_{collection}.json"
            out.write_text(json.dumps(failed, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"失败清单：{out}")


if __name__ == "__main__":
    main()
