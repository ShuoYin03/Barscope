#!/usr/bin/env python3
"""Import the manually reviewed QQ album CSV into BarScope with cross-platform artist ownership.

What this script does:
1. Reads qq_album_need_submit.csv (the user's final reviewed list).
2. Rehydrates each row from local QQ candidate JSON files so cover/tracks/QQ album MID are preserved.
3. Reads every album-level QQ singer credit, not just the first singer.
4. Resolves each QQ singer MID to an existing BarScope/NetEase artist ID using:
   - resolved qq_artist_matches*.json files;
   - exact normalized artist names / aliases in rappers.json;
   - exact normalized names / aliases in the live BarScope artists collection.
5. Persists the QQ Artist MID onto the matched BarScope artist record.
6. Imports only albums whose ALL album-level owners were resolved, using the same albums schema as the current catalogue.

The special Zhang Fangzhao album is forcibly corrected to QQ album MID 003hLetz4gRmoa.

Usage:
  python3 import_reviewed_qq_albums.py --preview
  python3 import_reviewed_qq_albums.py --commit

Outputs:
  qq_album_import_ready.json
  qq_album_import_mapping.csv
  qq_album_import_unresolved.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import time
import unicodedata
from pathlib import Path
from typing import Any

import requests

from qqmusic_client import QQMusicClient

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"
DEFAULT_CSV = BASE_DIR / "qq_album_need_submit.csv"
READY_JSON = BASE_DIR / "qq_album_import_ready.json"
MAPPING_CSV = BASE_DIR / "qq_album_import_mapping.csv"
UNRESOLVED_CSV = BASE_DIR / "qq_album_import_unresolved.csv"

SPECIAL_ZHANG_FANGZHAO_TITLE = "2022 wasted website"
SPECIAL_ZHANG_FANGZHAO_MID = "003hLetz4gRmoa"
SPECIAL_ZHANG_FANGZHAO_URL = "https://y.qq.com/n/ryqq_v2/albumDetail/003hLetz4gRmoa"


def norm(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    return re.sub(r"[\s\-_·•.。'\"“”‘’()（）\[\]【】/\\]+", "", text)


def parse_year(value: Any) -> int:
    match = re.search(r"(?:19|20)\d{2}", str(value or ""))
    return int(match.group(0)) if match else 0


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return [dict(row) for row in csv.DictReader(f)]


def load_candidate_index() -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for path in [
        BASE_DIR / "qq_album_need_submit.json",
        BASE_DIR / "qq_album_candidates.json",
        BASE_DIR / "qq_album_would_be_new.json",
    ]:
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for item in payload.get("results", []) or []:
            keys = {
                str(item.get("sourceId") or "").strip(),
                str(item.get("qqAlbumMid") or "").strip(),
                str(item.get("qqAlbumId") or "").strip(),
                str(item.get("sourceKey") or "").replace("qq:", "").strip(),
            }
            for key in keys:
                if key:
                    index[key] = item
    return index


def load_match_maps() -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]]]:
    by_mid: dict[str, dict[str, str]] = {}
    by_name: dict[str, dict[str, str]] = {}
    for path in sorted(BASE_DIR.glob("qq_artist_matches*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for row in payload.get("results", []) or []:
            if row.get("resolutionStatus") != "matched":
                continue
            best = row.get("bestCandidate") or {}
            mid = str(best.get("mid") or "").strip()
            netease_id = str(row.get("neteaseArtistId") or "").strip()
            display_name = str(row.get("displayName") or row.get("neteaseArtistName") or "").strip()
            barscope_id = str(row.get("barscopeArtistId") or "").strip()
            if not netease_id:
                continue
            record = {"neteaseArtistId": netease_id, "barscopeArtistId": barscope_id, "name": display_name}
            if mid:
                by_mid[mid] = record
            if display_name:
                by_name[norm(display_name)] = record
    return by_mid, by_name


def load_rappers_name_map() -> dict[str, dict[str, str]]:
    path = BASE_DIR / "rappers.json"
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    result: dict[str, dict[str, str]] = {}
    for row in payload.get("rappers", []) or []:
        netease_id = str(row.get("id") or row.get("neteaseArtistId") or "").strip()
        if not netease_id:
            continue
        names: list[str] = []
        for key in ("name", "artistName", "displayName", "aka"):
            value = row.get(key)
            if isinstance(value, str) and value.strip():
                names.append(value.strip())
        for key in ("aliases", "akas", "alias"):
            value = row.get(key)
            if isinstance(value, list):
                names.extend(str(x).strip() for x in value if str(x).strip())
            elif isinstance(value, str) and value.strip():
                names.extend(x.strip() for x in re.split(r"[,，/|]", value) if x.strip())
        record = {"neteaseArtistId": netease_id, "barscopeArtistId": str(row.get("barscopeArtistId") or ""), "name": names[0] if names else ""}
        for name in names:
            if norm(name):
                result[norm(name)] = record
    return result


def get_access_token(cfg: dict[str, Any]) -> str:
    r = requests.get(
        "https://api.weixin.qq.com/cgi-bin/token",
        params={"grant_type": "client_credential", "appid": cfg.get("appid", ""), "secret": cfg.get("appsecret", "")},
        timeout=15,
    )
    r.raise_for_status()
    payload = r.json()
    if not payload.get("access_token"):
        raise RuntimeError(f"获取 access_token 失败: {payload}")
    return str(payload["access_token"])


def db_query(token: str, env: str, query: str) -> list[dict[str, Any]]:
    r = requests.post(
        "https://api.weixin.qq.com/tcb/databasequery",
        params={"access_token": token},
        json={"env": env, "query": query},
        timeout=30,
    )
    r.raise_for_status()
    payload = r.json()
    rows = payload.get("data", []) or []
    return [json.loads(x) if isinstance(x, str) else x for x in rows]


def load_live_artist_maps(token: str, env: str) -> tuple[dict[str, dict[str, str]], dict[str, str]]:
    by_name: dict[str, dict[str, str]] = {}
    artist_doc_by_netease: dict[str, str] = {}
    offset = 0
    while True:
        rows = db_query(token, env, f'db.collection("artists").skip({offset}).limit(100).get()')
        if not rows:
            break
        for row in rows:
            nid = str(row.get("neteaseArtistId") or row.get("artistId") or "").strip()
            if not nid:
                continue
            if row.get("_id"):
                artist_doc_by_netease[nid] = str(row["_id"])
            names: list[str] = []
            for key in ("name", "artistName", "displayName", "aka"):
                value = row.get(key)
                if isinstance(value, str) and value.strip():
                    names.append(value.strip())
            for key in ("aliases", "akas", "alias"):
                value = row.get(key)
                if isinstance(value, list):
                    names.extend(str(x).strip() for x in value if str(x).strip())
                elif isinstance(value, str) and value.strip():
                    names.extend(x.strip() for x in re.split(r"[,，/|]", value) if x.strip())
            rec = {"neteaseArtistId": nid, "barscopeArtistId": str(row.get("_id") or ""), "name": names[0] if names else ""}
            for name in names:
                if norm(name):
                    by_name[norm(name)] = rec
        offset += len(rows)
        if len(rows) < 100:
            break
    return by_name, artist_doc_by_netease


def extract_album_singers(payload: Any) -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []
    seen: set[str] = set()

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            mid = str(value.get("singer_mid") or value.get("singerMID") or value.get("mid") or "").strip()
            name = str(value.get("singer_name") or value.get("singerName") or value.get("name") or "").strip()
            # Only accept dictionaries that actually look like singer records.
            singerish = any(k in value for k in ("singer_mid", "singerMID", "singer_id", "singerID"))
            if singerish and name and (mid or str(value.get("singer_id") or value.get("singerID") or "").strip()):
                key = mid or norm(name)
                if key not in seen:
                    seen.add(key)
                    candidates.append({"mid": mid, "name": name})
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(payload)
    return candidates


def resolve_artist(
    qq_mid: str,
    qq_name: str,
    by_mid: dict[str, dict[str, str]],
    *name_maps: dict[str, dict[str, str]],
) -> dict[str, str] | None:
    if qq_mid and qq_mid in by_mid:
        return by_mid[qq_mid]
    key = norm(qq_name)
    if key:
        for mapping in name_maps:
            if key in mapping:
                return mapping[key]
    return None


def db_update_artist_qq_link(token: str, env: str, doc_id: str, qq_mid: str, qq_name: str) -> None:
    if not doc_id or not qq_mid:
        return
    data = json.dumps({"qqArtistMid": qq_mid, "qqArtistName": qq_name}, ensure_ascii=False)
    query = f'db.collection("artists").doc({json.dumps(doc_id)}).update({{data:{data}}})'
    r = requests.post(
        "https://api.weixin.qq.com/tcb/databaseupdate",
        params={"access_token": token},
        json={"env": env, "query": query},
        timeout=20,
    )
    r.raise_for_status()


def invoke_upload(token: str, env: str, albums: list[dict[str, Any]]) -> dict[str, Any]:
    r = requests.post(
        "https://api.weixin.qq.com/tcb/invokecloudfunction",
        params={"access_token": token, "env": env, "name": "uploadAlbums"},
        json={"albums": albums, "action": "upsert"},
        timeout=90,
    )
    r.raise_for_status()
    payload = r.json()
    if payload.get("errcode", 0) != 0:
        raise RuntimeError(f"uploadAlbums 调用失败: {payload}")
    return json.loads(payload.get("resp_data", "{}"))


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="关联 QQ/网易云艺人 ID，并导入最终审核通过的 QQ 专辑")
    parser.add_argument("--csv", default=str(DEFAULT_CSV))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preview", action="store_true", help="只生成映射和待导入文件，不写数据库")
    mode.add_argument("--commit", action="store_true", help="确认写入 artist QQ ID 关联并导入 albums")
    args = parser.parse_args()

    csv_path = Path(args.csv)
    if not csv_path.exists():
        raise SystemExit(f"找不到审核 CSV: {csv_path}")
    if not CONFIG_FILE.exists():
        raise SystemExit(f"找不到配置文件: {CONFIG_FILE}")

    rows = read_csv_rows(csv_path)
    candidate_index = load_candidate_index()
    by_mid, match_name_map = load_match_maps()
    rapper_name_map = load_rappers_name_map()

    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    token = get_access_token(cfg)
    env = str(cfg.get("env") or "")
    live_name_map, artist_doc_by_netease = load_live_artist_maps(token, env)

    client = QQMusicClient(timeout=20)
    ready: list[dict[str, Any]] = []
    mapping_rows: list[dict[str, Any]] = []
    unresolved_rows: list[dict[str, Any]] = []
    artist_links_to_write: dict[tuple[str, str], dict[str, str]] = {}

    print(f"读取审核名单 {len(rows)} 张，开始关联 QQ 专辑级艺人归属……")

    for idx, row in enumerate(rows, 1):
        title = str(row.get("QQ专辑名") or row.get("专辑名") or "").strip()
        csv_album_id = str(row.get("QQ Album ID") or row.get("QQ Album MID") or "").strip()
        mapped_primary_nid = str(row.get("网易云映射艺人ID") or row.get("网易云 Artist ID") or "").strip()
        csv_artist = str(row.get("艺人") or "").strip()

        candidate = candidate_index.get(csv_album_id, {})
        album_mid = str(candidate.get("qqAlbumMid") or "").strip()
        album_id = str(candidate.get("qqAlbumId") or csv_album_id or "").strip()

        if norm(title) == norm(SPECIAL_ZHANG_FANGZHAO_TITLE) or "wastedwebsite" in norm(title):
            album_mid = SPECIAL_ZHANG_FANGZHAO_MID

        # If CSV itself contains a MID-shaped ID, use it directly.
        if not album_mid and re.fullmatch(r"[A-Za-z0-9]{14}", csv_album_id):
            album_mid = csv_album_id

        if not album_mid:
            unresolved_rows.append({
                "QQ专辑名": title, "CSV艺人": csv_artist, "QQ Album ID": csv_album_id,
                "未解决原因": "找不到 QQ Album MID；请确认本地 qq_album_candidates.json 仍存在",
            })
            continue

        try:
            album_payload = client._get_legacy_album_payload(album_mid)  # noqa: SLF001 - QQ client has no public album-credit method yet.
            singers = extract_album_singers(album_payload)
        except Exception as exc:
            unresolved_rows.append({
                "QQ专辑名": title, "CSV艺人": csv_artist, "QQ Album ID": csv_album_id,
                "QQ Album MID": album_mid, "未解决原因": f"QQ 专辑详情读取失败: {exc}",
            })
            continue

        # Safe fallback for QQ endpoints that expose no album-level singer array.
        if not singers:
            fallback_mid = str(candidate.get("qqArtistMid") or "").strip()
            singers = [{"mid": fallback_mid, "name": csv_artist}] if csv_artist else []

        owners: list[dict[str, Any]] = []
        unresolved_names: list[str] = []
        for singer_index, singer in enumerate(singers):
            qq_mid = str(singer.get("mid") or "").strip()
            qq_name = str(singer.get("name") or "").strip()
            resolved = resolve_artist(qq_mid, qq_name, by_mid, match_name_map, rapper_name_map, live_name_map)

            # The reviewed CSV already carries the trusted mapped NetEase artist for the seed rapper.
            if resolved is None and singer_index == 0 and mapped_primary_nid:
                resolved = {"neteaseArtistId": mapped_primary_nid, "barscopeArtistId": "", "name": csv_artist or qq_name}

            if resolved is None:
                unresolved_names.append(f"{qq_name}({qq_mid})")
                continue

            nid = str(resolved.get("neteaseArtistId") or "").strip()
            if not nid:
                unresolved_names.append(f"{qq_name}({qq_mid})")
                continue
            owner = {"id": int(nid) if nid.isdigit() else nid, "name": str(resolved.get("name") or qq_name or csv_artist).strip()}
            if not any(str(x["id"]) == str(owner["id"]) for x in owners):
                owners.append(owner)
            if qq_mid:
                by_mid[qq_mid] = {"neteaseArtistId": nid, "barscopeArtistId": str(resolved.get("barscopeArtistId") or ""), "name": owner["name"]}
                artist_links_to_write[(nid, qq_mid)] = {"name": owner["name"], "qqName": qq_name}
                mapping_rows.append({
                    "QQ专辑名": title,
                    "QQ艺人名": qq_name,
                    "QQ Artist MID": qq_mid,
                    "网易云 Artist ID": nid,
                    "BarScope Artist ID": str(resolved.get("barscopeArtistId") or artist_doc_by_netease.get(nid, "")),
                    "关联状态": "已关联",
                })

        if unresolved_names or not owners:
            unresolved_rows.append({
                "QQ专辑名": title,
                "CSV艺人": csv_artist,
                "QQ Album ID": csv_album_id,
                "QQ Album MID": album_mid,
                "未解决原因": "未能关联全部专辑归属艺人: " + "、".join(unresolved_names or ["无可用艺人归属"]),
            })
            continue

        # Rehydrate metadata/tracks from the original candidate whenever possible.
        tracks = candidate.get("tracks") or []
        if not tracks:
            detailed = client.get_album_tracks_detailed(album_mid, limit=500)
            tracks = [{"no": i + 1, "name": t.title, "durationMs": t.duration_ms} for i, t in enumerate(detailed)]
        else:
            tracks = [
                {**t, "no": int(t.get("no") or i + 1)} if isinstance(t, dict) else {"no": i + 1, "name": str(t)}
                for i, t in enumerate(tracks)
            ]

        release_date = str(candidate.get("releaseDate") or row.get("发行日期") or "").strip()
        if not release_date:
            try:
                release_date = client.get_album_publish_date(album_mid)
            except Exception:
                release_date = ""

        owner_ids = [str(x["id"]) for x in owners]
        owner_names = [str(x["name"]) for x in owners]
        qq_owner_mids = [str(s.get("mid") or "") for s in singers if str(s.get("mid") or "").strip()]
        first_owner = owners[0]

        ready.append({
            "title": title or str(candidate.get("title") or "").strip(),
            "artist": "/".join(owner_names),
            "primaryArtist": str(first_owner["name"]),
            "neteaseArtistId": str(first_owner["id"]),
            "artistIds": owner_ids,
            "ownerArtistIds": owner_ids,
            "ownerArtists": owners,
            "ownershipSource": "qq-album-credits",
            "isMultiArtist": len(owner_ids) > 1,
            "releaseDate": release_date,
            "releaseYear": parse_year(release_date),
            "coverUrl": str(candidate.get("coverUrl") or f"https://y.qq.com/music/photo_new/T002R800x800M000{album_mid}.jpg"),
            "genres": candidate.get("genres") or [],
            "sourceId": album_mid,
            "source": "qq",
            "sourcePlatform": "qq",
            "sourceKey": f"qq:{album_mid}",
            "qqAlbumMid": album_mid,
            "qqAlbumId": album_id,
            "qqArtistMid": qq_owner_mids[0] if qq_owner_mids else "",
            "qqArtistMids": qq_owner_mids,
            "qqAlbumUrl": SPECIAL_ZHANG_FANGZHAO_URL if album_mid == SPECIAL_ZHANG_FANGZHAO_MID else f"https://y.qq.com/n/ryqq_v2/albumDetail/{album_mid}",
            "trackCount": len(tracks) or int(candidate.get("trackCount") or row.get("曲目数") or 0),
            "tracks": tracks,
            "avgScore": 0,
            "reviewCount": 0,
        })

        print(f"  [{idx}/{len(rows)}] ✓ {title} → {' / '.join(owner_names)}")

    READY_JSON.write_text(json.dumps({"source": "reviewed_qq_album_import", "count": len(ready), "results": ready}, ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(MAPPING_CSV, mapping_rows, ["QQ专辑名", "QQ艺人名", "QQ Artist MID", "网易云 Artist ID", "BarScope Artist ID", "关联状态"])
    write_csv(UNRESOLVED_CSV, unresolved_rows, ["QQ专辑名", "CSV艺人", "QQ Album ID", "QQ Album MID", "未解决原因"])

    print(f"\n准备完成：可导入 {len(ready)} 张；未完全关联 {len(unresolved_rows)} 张")
    print(f"  待导入: {READY_JSON}")
    print(f"  艺人关联: {MAPPING_CSV}")
    print(f"  未解决: {UNRESOLVED_CSV}")

    if args.preview:
        print("\n[preview] 未写数据库。确认未解决列表为空后运行 --commit。")
        return

    if unresolved_rows:
        raise SystemExit("\n为避免错误归属，本次未导入：仍有专辑未完成全部艺人关联。先查看 qq_album_import_unresolved.csv。")

    print("\n写入 QQ Artist MID ↔ NetEase Artist ID 关联……")
    linked = 0
    for (nid, qq_mid), meta in artist_links_to_write.items():
        doc_id = artist_doc_by_netease.get(nid, "")
        if not doc_id:
            print(f"  [跳过] artists 集合找不到 NetEase ID={nid}，但专辑归属仍保留该 ID")
            continue
        db_update_artist_qq_link(token, env, doc_id, qq_mid, meta.get("qqName") or meta.get("name") or "")
        linked += 1
        time.sleep(0.03)
    print(f"  已更新 {linked} 条艺人 QQ ID 关联")

    totals = {"inserted": 0, "updated": 0, "skipped": 0, "blocked": 0, "errors": 0}
    for start in range(0, len(ready), 20):
        batch = ready[start:start + 20]
        result = invoke_upload(token, env, batch)
        for key in totals:
            totals[key] += int(result.get(key, 0) or 0)
        print(f"  导入 {start + 1}-{start + len(batch)}/{len(ready)}：新增 {result.get('inserted', 0)}，更新 {result.get('updated', 0)}，错误 {result.get('errors', 0)}")
        time.sleep(0.2)

    print("\n导入完成")
    print(f"  新增: {totals['inserted']}  更新: {totals['updated']}  跳过: {totals['skipped']}  tombstone阻止: {totals['blocked']}  错误: {totals['errors']}")


if __name__ == "__main__":
    main()
