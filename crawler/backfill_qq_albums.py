#!/usr/bin/env python3
"""Backfill QQ-sourced Soundive albums/candidates into the canonical album schema.

Repairs:
- canonical Soundive rapper ownership
- QQ releaseDate / releaseYear (including QQ's aDate field)
- record company / label
- full track list
- per-track featuring guests
- aggregate featuringGuests + trackCount

Important ownership rule:
An existing valid neteaseArtistId is treated as the strongest album-owner anchor. This
prevents album-level QQ credits or track participants from expanding a single-owner album
into multiple Soundive owners. Other credited artists remain track-level featuring guests.

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
from datetime import datetime, timezone
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
    return re.sub(
        r"[\s\-_.·•。'\"“”‘’()（）\[\]【】/\\?!！？，,:：]+",
        "",
        str(value or "").strip().lower(),
    ).replace("explicit", "")


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
    """QQ singer MID -> canonical Soundive/NetEase artist identity."""
    result: dict[str, dict[str, str]] = {}
    paths = sorted(
        set(
            glob.glob(str(BASE_DIR / "qq_artist_matches*.json"))
            + glob.glob(str(BASE_DIR / "*artist*match*.json"))
        )
    )
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
    for artist in artists:
        aid = str(artist.get("artistId") or "").strip()
        name = str(artist.get("artistName") or "").strip()
        if not aid or not name:
            continue
        by_id[aid] = artist
        names = [name, artist.get("aka")]
        names += artist.get("aliases") if isinstance(artist.get("aliases"), list) else []
        for candidate_name in names:
            key = norm(candidate_name)
            if key:
                by_name.setdefault(key, artist)
    return by_id, by_name


def post_musicu(payload: dict[str, Any]) -> dict[str, Any]:
    r = requests.post(MUSICU_URL, json=payload, headers=HEADERS, timeout=20)
    r.raise_for_status()
    return r.json()


def album_detail(mid: str) -> dict[str, Any]:
    r = requests.get(
        LEGACY_ALBUM_INFO_URL,
        params={"albummid": mid, "format": "json", "platform": "yqq", "newsong": 1},
        headers=HEADERS,
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def album_tracks(mid: str) -> list[dict[str, Any]]:
    payload = {
        "comm": {"ct": 24, "cv": 0},
        "albumSongList": {
            "module": "music.musichallAlbum.AlbumSongList",
            "method": "GetAlbumSongList",
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

    out: list[dict[str, Any]] = []
    for row in rows or []:
        song = (
            (row or {}).get("songInfo")
            or (row or {}).get("songinfo")
            or (row or {}).get("musicData")
            or (row or {}).get("data")
            or row
        )
        if not isinstance(song, dict):
            continue
        name = str(song.get("title") or song.get("songname") or song.get("songName") or song.get("name") or "").strip()
        if not name:
            continue
        singer_rows = song.get("singer") or song.get("singerList") or song.get("singer_list") or []
        if not isinstance(singer_rows, list):
            singer_rows = [singer_rows]
        singers = []
        for singer in singer_rows:
            if not isinstance(singer, dict):
                continue
            sname = html.unescape(str(singer.get("name") or singer.get("singerName") or singer.get("singer_name") or "")).strip()
            smid = str(singer.get("mid") or singer.get("singerMID") or singer.get("singer_mid") or "").strip()
            if sname or smid:
                singers.append({"name": sname, "mid": smid})
        try:
            seconds = int(float(song.get("interval") or song.get("duration") or 0) or 0)
        except (TypeError, ValueError):
            seconds = 0
        out.append(
            {
                "name": name,
                "mid": str(song.get("mid") or song.get("songmid") or song.get("songMid") or ""),
                "singers": singers,
                "duration": seconds,
            }
        )
    return out


def walk_find(value: Any, keys: tuple[str, ...]) -> str:
    if isinstance(value, dict):
        for key in keys:
            raw = value.get(key)
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


def normalize_release_date(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""

    full = re.search(r"((?:19|20)\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})", text)
    if full:
        return f"{full.group(1)}-{int(full.group(2)):02d}-{int(full.group(3)):02d}"

    compact = re.search(r"\b((?:19|20)\d{2})(\d{2})(\d{2})\b", text)
    if compact:
        return f"{compact.group(1)}-{compact.group(2)}-{compact.group(3)}"

    # Some QQ payload variants expose Unix timestamps instead of a formatted date.
    if re.fullmatch(r"\d{10,13}", text):
        try:
            timestamp = int(text)
            if len(text) == 13:
                timestamp //= 1000
            year = datetime.fromtimestamp(timestamp, tz=timezone.utc).year
            if 1990 <= year <= datetime.now().year + 1:
                return datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d")
        except (OverflowError, OSError, ValueError):
            pass

    year = re.search(r"(?:19|20)\d{2}", text)
    return year.group(0) if year else ""


def release_date(detail: dict[str, Any], record: dict[str, Any]) -> tuple[str, str]:
    """Return normalized release date and the field/source that produced it."""
    data = detail.get("data") if isinstance(detail.get("data"), dict) else detail

    # QQ's legacy album endpoint commonly exposes the visible album release date as `aDate`.
    # Check known album-level keys first, before any recursive scan can accidentally pick a track date.
    priority_keys = (
        "aDate",
        "adate",
        "publish_date",
        "publishDate",
        "pub_time",
        "publicTime",
        "publictime",
        "release_date",
        "releaseDate",
        "time_public",
        "date",
    )
    if isinstance(data, dict):
        for key in priority_keys:
            normalized = normalize_release_date(data.get(key))
            if normalized:
                return normalized, f"detail.data.{key}"

    recursive = walk_find(detail, priority_keys)
    normalized = normalize_release_date(recursive)
    if normalized:
        return normalized, "detail.recursive"

    # Preserve any usable date that was already stored in Soundive rather than replacing it with blank.
    for key in ("releaseDate", "publishDate", "aDate"):
        normalized = normalize_release_date(record.get(key))
        if normalized:
            return normalized, f"record.{key}"

    release_year = str(record.get("releaseYear") or "").strip()
    if re.fullmatch(r"(?:19|20)\d{2}", release_year):
        return release_year, "record.releaseYear"

    return "", "missing"


def top_level_singers(detail: dict[str, Any]) -> list[dict[str, str]]:
    """Read album-level singers only; never recursively collect track artists."""
    data = detail.get("data") if isinstance(detail.get("data"), dict) else detail
    candidates: list[Any] = []
    if isinstance(data, dict):
        for key in ("singer", "singerList", "singer_list"):
            if data.get(key):
                candidates = data[key] if isinstance(data[key], list) else [data[key]]
                break

    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for singer in candidates:
        if not isinstance(singer, dict):
            continue
        name = html.unescape(str(singer.get("name") or singer.get("singerName") or singer.get("singer_name") or "")).strip()
        mid = str(singer.get("mid") or singer.get("singerMID") or singer.get("singer_mid") or "").strip()
        key = mid or norm(name)
        if key and key not in seen:
            seen.add(key)
            out.append({"name": name, "mid": mid})
    return out


def canonical_artist(aid: str, by_id: dict[str, dict]) -> dict[str, str] | None:
    artist = by_id.get(str(aid or "").strip())
    if not artist:
        return None
    return {"id": str(artist["artistId"]), "name": str(artist["artistName"])}


def resolve_owners(
    record: dict[str, Any],
    singers: list[dict[str, str]],
    local_map: dict[str, dict[str, str]],
    by_id: dict[str, dict],
    by_name: dict[str, dict],
) -> tuple[list[dict[str, str]], str]:
    """Resolve canonical album owners without promoting featured artists to owners.

    Priority:
    1. Existing valid neteaseArtistId: this is the original Soundive ownership anchor.
    2. Existing qqArtistMid mapped by the cross-platform resolver.
    3. Existing ownerArtistIds (only when no stronger single-owner anchor exists).
    4. Album-level QQ singers via MID mapping / canonical alias matching.
    """
    primary_id = str(record.get("neteaseArtistId") or "").strip()
    primary = canonical_artist(primary_id, by_id)
    if primary:
        return [primary], "record.neteaseArtistId"

    record_qq_mid = str(record.get("qqArtistMid") or "").strip()
    mapped = local_map.get(record_qq_mid)
    if mapped:
        canonical = canonical_artist(str(mapped.get("id") or ""), by_id)
        if canonical:
            return [canonical], "record.qqArtistMid"

    existing_owner_ids = record.get("ownerArtistIds") if isinstance(record.get("ownerArtistIds"), list) else []
    existing: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw_id in existing_owner_ids:
        canonical = canonical_artist(str(raw_id), by_id)
        if canonical and canonical["id"] not in seen:
            existing.append(canonical)
            seen.add(canonical["id"])
    if existing:
        return existing, "record.ownerArtistIds"

    resolved: list[dict[str, str]] = []
    seen.clear()
    for singer in singers:
        mid = str(singer.get("mid") or "").strip()
        candidate: dict[str, str] | None = None
        mapped = local_map.get(mid)
        if mapped:
            candidate = canonical_artist(str(mapped.get("id") or ""), by_id)
        if not candidate:
            hit = by_name.get(norm(singer.get("name")))
            if hit:
                candidate = {"id": str(hit["artistId"]), "name": str(hit["artistName"])}
        if candidate and candidate["id"] not in seen:
            resolved.append(candidate)
            seen.add(candidate["id"])

    return resolved, "album.singers"


def owner_qq_mids(
    record: dict[str, Any],
    singers: list[dict[str, str]],
    owner_ids: list[str],
    local_map: dict[str, dict[str, str]],
    by_name: dict[str, dict],
) -> set[str]:
    """Only return QQ MIDs that actually resolve to a selected Soundive owner."""
    owner_id_set = set(owner_ids)
    mids: set[str] = set()

    record_mid = str(record.get("qqArtistMid") or "").strip()
    mapped_record = local_map.get(record_mid)
    if record_mid and mapped_record and str(mapped_record.get("id") or "") in owner_id_set:
        mids.add(record_mid)

    for singer in singers:
        mid = str(singer.get("mid") or "").strip()
        if not mid:
            continue
        mapped = local_map.get(mid)
        if mapped and str(mapped.get("id") or "") in owner_id_set:
            mids.add(mid)
            continue
        hit = by_name.get(norm(singer.get("name")))
        if hit and str(hit.get("artistId") or "") in owner_id_set:
            mids.add(mid)
    return mids


def aggregate_guests(tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    agg: dict[str, dict[str, Any]] = {}
    for track in tracks:
        for guest in track.get("guests", []):
            key = str(guest.get("id") or "") or norm(guest.get("name"))
            if not key:
                continue
            row = agg.setdefault(
                key,
                {"id": guest.get("id") or 0, "name": guest.get("name") or "", "count": 0, "trackNos": []},
            )
            row["count"] += 1
            row["trackNos"].append(track["no"])
    return sorted(agg.values(), key=lambda x: (-x["count"], x["name"]))


def enrich(
    record: dict[str, Any],
    local_map: dict[str, dict[str, str]],
    by_id: dict[str, dict],
    by_name: dict[str, dict],
) -> dict[str, Any]:
    platform = str(record.get("sourcePlatform") or record.get("source") or "").lower()
    mid = str(record.get("qqAlbumMid") or (record.get("sourceId") if platform == "qq" else "") or "").strip()
    if not mid:
        raise RuntimeError("missing qqAlbumMid")

    detail = album_detail(mid)
    raw_tracks = album_tracks(mid)
    singers = top_level_singers(detail)
    if not singers:
        mids = record.get("qqArtistMids") or ([record.get("qqArtistMid")] if record.get("qqArtistMid") else [])
        names = [x.strip() for x in str(record.get("artist") or record.get("primaryArtist") or "").split("/") if x.strip()]
        singers = [{"mid": str(mids[i]) if i < len(mids) else "", "name": name} for i, name in enumerate(names)]

    owners, owner_source = resolve_owners(record, singers, local_map, by_id, by_name)
    owner_names = [x["name"] for x in owners]
    owner_ids = [x["id"] for x in owners]

    # If no canonical Soundive owner can be resolved, preserve display text but do not invent IDs.
    if not owner_names:
        existing_name = str(record.get("primaryArtist") or record.get("artist") or "").split("/")[0].strip()
        if existing_name:
            owner_names = [existing_name]
        elif singers:
            owner_names = [str(singers[0].get("name") or "").strip()]

    resolved_owner_mids = owner_qq_mids(record, singers, owner_ids, local_map, by_name)
    owner_name_keys = {norm(name) for name in owner_names if name}

    tracks: list[dict[str, Any]] = []
    for index, track in enumerate(raw_tracks, 1):
        credited = [
            {"id": 0, "name": singer.get("name", ""), "qqArtistMid": singer.get("mid", "")}
            for singer in track.get("singers", [])
            if singer.get("name")
        ]
        guests = []
        seen_guests: set[str] = set()
        for artist in credited:
            artist_mid = str(artist["qqArtistMid"] or "")
            artist_name_key = norm(artist["name"])
            if artist_mid and artist_mid in resolved_owner_mids:
                continue
            if artist_name_key and artist_name_key in owner_name_keys:
                continue

            mapped_guest = local_map.get(artist_mid)
            guest_id = str(mapped_guest.get("id") or "") if mapped_guest else ""
            if guest_id not in by_id:
                guest_id = ""
            guest_name = str(by_id[guest_id]["artistName"]) if guest_id else artist["name"]
            guest_key = guest_id or norm(guest_name)
            if not guest_key or guest_key in seen_guests:
                continue
            seen_guests.add(guest_key)
            guests.append({"id": guest_id or 0, "name": guest_name})

        tracks.append(
            {
                "no": index,
                "name": track["name"],
                "artists": [{"id": 0, "name": artist["name"]} for artist in credited]
                or [{"id": owner["id"], "name": owner["name"]} for owner in owners],
                "guests": guests,
                "hasFeaturing": bool(guests),
                "duration": track.get("duration", 0),
                "durationMs": int(track.get("duration", 0)) * 1000,
                "qqSongMid": track.get("mid", ""),
            }
        )

    date, date_source = release_date(detail, record)
    year_match = re.search(r"(?:19|20)\d{2}", date)
    company = walk_find(
        detail,
        ("company", "company_name", "companyName", "label", "record_company", "recordCompany"),
    ) or str(record.get("company") or "")
    title = walk_find(detail, ("album_name", "albumName")) or str(record.get("title") or "")

    qq_mids = sorted(resolved_owner_mids)
    if not qq_mids:
        existing_mid = str(record.get("qqArtistMid") or "").strip()
        if existing_mid:
            qq_mids = [existing_mid]

    patch = {
        "title": title,
        "artist": " / ".join(owner_names),
        "primaryArtist": owner_names[0] if owner_names else "",
        "neteaseArtistId": owner_ids[0] if owner_ids else "",
        "artistIds": owner_ids,
        "ownerArtistIds": owner_ids,
        "ownerArtists": owners,
        "qqArtistMid": qq_mids[0] if qq_mids else "",
        "qqArtistMids": qq_mids,
        "releaseDate": date,
        "releaseYear": int(year_match.group(0)) if year_match else 0,
        "company": company,
        "tracks": tracks,
        "trackCount": len(tracks),
        "featuringGuests": aggregate_guests(tracks),
        "metadataCompleteness": {
            "releaseDate": bool(date),
            "company": bool(company),
            "tracks": len(tracks),
            "ownerArtistIds": len(owner_ids),
        },
        "qqMetadataBackfilledAt": int(time.time()),
        "qqMetadataDebug": {
            "releaseDateSource": date_source,
            "ownerSource": owner_source,
        },
    }
    return patch


def push_updates(
    token: str,
    env: str,
    collection: str,
    updates: list[dict[str, Any]],
    batch_size: int = 10,
) -> tuple[int, int]:
    ok = fail = 0
    for i in range(0, len(updates), batch_size):
        batch = updates[i : i + batch_size]
        res = invoke(token, env, {"action": "update", "collection": collection, "updates": batch})
        ok += int(res.get("updated", 0))
        fail += int(res.get("failed", 0))
        print(
            f"  写入 {i + 1}-{i + len(batch)}/{len(updates)}：成功 {res.get('updated', 0)}，失败 {res.get('failed', 0)}"
        )
        time.sleep(0.25)
    return ok, fail


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--albums-only", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--sleep", type=float, default=0.15)
    args = parser.parse_args()

    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    token = get_token(cfg)
    env = str(cfg.get("env") or "")
    if not env:
        raise SystemExit("config.json 缺少 env")

    artists = fetch_all_artists(token, env)
    by_id, by_name = build_artist_indexes(artists)
    local_map = load_local_qq_mappings()
    print(f"已加载 {len(artists)} 位 Soundive rapper；本地 QQ MID 映射 {len(local_map)} 条")

    collections = ["albums"] if args.albums_only else ["albums", "album_candidates"]
    for collection in collections:
        records = fetch_all_records(token, env, collection)
        if args.limit:
            records = records[: args.limit]
        print(f"\n{collection}: 找到 {len(records)} 条 QQ 记录，开始补全…")

        updates = []
        failed = []
        missing_dates = 0
        for idx, row in enumerate(records, 1):
            try:
                patch = enrich(row, local_map, by_id, by_name)
                updates.append({"_id": row["_id"], "patch": patch})
                if not patch["releaseDate"]:
                    missing_dates += 1
                debug = patch.get("qqMetadataDebug") or {}
                print(
                    f"  [{idx}/{len(records)}] ✓ {patch['title']} | "
                    f"{patch['releaseDate'] or '无日期'} [{debug.get('releaseDateSource', 'unknown')}] | "
                    f"{patch['trackCount']} tracks | owner={patch['artist'] or '未匹配'} "
                    f"[{debug.get('ownerSource', 'unknown')}] | feat={len(patch['featuringGuests'])}"
                )
            except Exception as exc:
                failed.append({"_id": row.get("_id"), "title": row.get("title"), "error": str(exc)})
                print(f"  [{idx}/{len(records)}] ✗ {row.get('title')}：{exc}")
            time.sleep(max(args.sleep, 0))

        if args.dry_run:
            print(
                f"预览完成：可更新 {len(updates)}，失败 {len(failed)}，仍缺日期 {missing_dates}；未写数据库"
            )
        else:
            ok, write_fail = push_updates(token, env, collection, updates)
            print(
                f"{collection} 回填完成：成功 {ok}，抓取失败 {len(failed)}，写入失败 {write_fail}，仍缺日期 {missing_dates}"
            )

        if failed:
            out = BASE_DIR / f"qq_backfill_failed_{collection}.json"
            out.write_text(json.dumps(failed, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"失败清单：{out}")


if __name__ == "__main__":
    main()
