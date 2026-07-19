#!/usr/bin/env python3
"""Read-only dedupe for QQ album candidates against the BarScope Cloud DB.

This script DOES NOT write to Cloud DB.

Inputs:
  - qq_album_candidates.json
  - config.json with appid/appsecret/env

Outputs:
  - qq_album_dedupe_exact_duplicates.json
  - qq_album_dedupe_suspected_duplicates.json
  - qq_album_dedupe_new_candidates.json
  - qq_album_dedupe_summary.json

Matching strategy:
  1. Exact platform identity: sourceKey / QQ album MID / sourceId on QQ rows.
  2. Exact cross-platform identity: same mapped artist + normalized title.
  3. Suspected duplicate: same mapped artist + highly similar normalized title.

The script intentionally does not require releaseYear because QQ catalogue rows may have
releaseYear=0. Release year is used only as supporting evidence when present.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

import requests

WECHAT_API = "https://api.weixin.qq.com"
PAGE_SIZE = 100


def normalize_title(value: Any) -> str:
    text = str(value or "").strip().lower()
    # Keep letters/numbers/CJK; remove formatting punctuation and whitespace.
    return re.sub(r"[\s\u3000《》「」『』【】\[\]()（）.,，。:：;；!！?？'\"“”‘’_\-·•/\\]+", "", text)


def clean(value: Any) -> str:
    return str(value or "").strip()


def as_str_set(values: Iterable[Any]) -> set[str]:
    return {clean(v) for v in values if clean(v)}


def candidate_artist_ids(item: Dict[str, Any]) -> set[str]:
    ids = set()
    ids.update(as_str_set(item.get("ownerArtistIds") or []))
    ids.update(as_str_set(item.get("artistIds") or []))
    for key in ("barscopeArtistId", "neteaseArtistId"):
        value = clean(item.get(key))
        if value:
            ids.add(value)
    return ids


def db_artist_ids(album: Dict[str, Any]) -> set[str]:
    ids = set()
    ids.update(as_str_set(album.get("ownerArtistIds") or []))
    ids.update(as_str_set(album.get("artistIds") or []))
    for key in ("barscopeArtistId", "neteaseArtistId"):
        value = clean(album.get(key))
        if value:
            ids.add(value)
    return ids


def source_platform(item: Dict[str, Any]) -> str:
    return clean(item.get("sourcePlatform") or item.get("source") or "").lower()


def qq_identity_values(item: Dict[str, Any]) -> set[str]:
    values = set()
    for key in ("sourceId", "qqAlbumMid", "qqAlbumId"):
        value = clean(item.get(key))
        if value:
            values.add(value)
    source_key = clean(item.get("sourceKey"))
    if source_key:
        values.add(source_key)
    return values


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, payload: Any) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def get_access_token(appid: str, appsecret: str) -> str:
    resp = requests.get(
        f"{WECHAT_API}/cgi-bin/token",
        params={"grant_type": "client_credential", "appid": appid, "secret": appsecret},
        timeout=20,
    )
    resp.raise_for_status()
    data = resp.json()
    token = data.get("access_token")
    if not token:
        raise RuntimeError(f"获取 access_token 失败: {data}")
    return str(token)


def database_query(token: str, env: str, query: str) -> Dict[str, Any]:
    resp = requests.post(
        f"{WECHAT_API}/tcb/databasequery",
        params={"access_token": token},
        json={"env": env, "query": query},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("errcode", 0) != 0:
        raise RuntimeError(f"Cloud DB 查询失败: {data}")
    return data


def fetch_all_albums(token: str, env: str, page_size: int = PAGE_SIZE) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    offset = 0
    while True:
        query = f'db.collection("albums").skip({offset}).limit({page_size}).get()'
        data = database_query(token, env, query)
        raw_rows = data.get("data") or []
        batch: List[Dict[str, Any]] = []
        for raw in raw_rows:
            if isinstance(raw, str):
                try:
                    row = json.loads(raw)
                except json.JSONDecodeError:
                    continue
            elif isinstance(raw, dict):
                row = raw
            else:
                continue
            batch.append(row)
        rows.extend(batch)
        print(f"  已读取数据库专辑: {len(rows)}", flush=True)
        if len(batch) < page_size:
            break
        offset += page_size
        time.sleep(0.05)
    return rows


def title_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    # Avoid aggressive fuzzy matching on very short titles.
    if min(len(a), len(b)) <= 2:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def summarize_album(album: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "_id": album.get("_id"),
        "title": album.get("title"),
        "artist": album.get("artist"),
        "primaryArtist": album.get("primaryArtist"),
        "releaseDate": album.get("releaseDate"),
        "releaseYear": album.get("releaseYear"),
        "source": album.get("source"),
        "sourcePlatform": album.get("sourcePlatform"),
        "sourceId": album.get("sourceId"),
        "sourceKey": album.get("sourceKey"),
        "qqAlbumMid": album.get("qqAlbumMid"),
        "qqAlbumId": album.get("qqAlbumId"),
        "neteaseArtistId": album.get("neteaseArtistId"),
        "barscopeArtistId": album.get("barscopeArtistId"),
        "artistIds": album.get("artistIds"),
        "ownerArtistIds": album.get("ownerArtistIds"),
    }


def dedupe(
    candidates: List[Dict[str, Any]],
    albums: List[Dict[str, Any]],
    fuzzy_threshold: float,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    exact: List[Dict[str, Any]] = []
    suspected: List[Dict[str, Any]] = []
    new_items: List[Dict[str, Any]] = []

    # Exact QQ identity index.
    qq_identity_index: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    # Artist indexes to keep comparisons tight and avoid false positives.
    artist_index: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    for album in albums:
        if source_platform(album) == "qq" or album.get("qqAlbumMid") or album.get("qqAlbumId"):
            for identity in qq_identity_values(album):
                qq_identity_index[identity].append(album)
        for artist_id in db_artist_ids(album):
            artist_index[artist_id].append(album)

    for idx, item in enumerate(candidates, 1):
        item_title = normalize_title(item.get("title"))
        item_artist_ids = candidate_artist_ids(item)

        # 1) Exact source identity.
        source_hits: List[Dict[str, Any]] = []
        seen_source_ids = set()
        for identity in qq_identity_values(item):
            for album in qq_identity_index.get(identity, []):
                album_id = clean(album.get("_id")) or repr(album)
                if album_id not in seen_source_ids:
                    seen_source_ids.add(album_id)
                    source_hits.append(album)
        if source_hits:
            exact.append({
                "matchType": "exact_source_identity",
                "candidate": item,
                "matches": [summarize_album(x) for x in source_hits],
            })
            continue

        # Candidate pool: same mapped artist. A candidate without a mapped artist is not
        # auto-marked duplicate by title alone.
        pool: List[Dict[str, Any]] = []
        seen_pool = set()
        for artist_id in item_artist_ids:
            for album in artist_index.get(artist_id, []):
                album_id = clean(album.get("_id")) or repr(album)
                if album_id not in seen_pool:
                    seen_pool.add(album_id)
                    pool.append(album)

        # 2) Exact normalized title under the same mapped artist.
        exact_title_hits = [a for a in pool if item_title and normalize_title(a.get("title")) == item_title]
        if exact_title_hits:
            exact.append({
                "matchType": "exact_artist_and_title",
                "candidate": item,
                "matches": [summarize_album(x) for x in exact_title_hits],
            })
            continue

        # 3) Fuzzy same-artist title match; report only, never auto-remove.
        fuzzy_hits = []
        for album in pool:
            db_title = normalize_title(album.get("title"))
            score = title_similarity(item_title, db_title)
            if score >= fuzzy_threshold:
                fuzzy_hits.append((score, album))
        fuzzy_hits.sort(key=lambda pair: pair[0], reverse=True)
        if fuzzy_hits:
            suspected.append({
                "matchType": "suspected_artist_and_similar_title",
                "candidate": item,
                "matches": [
                    {"similarity": round(score, 4), **summarize_album(album)}
                    for score, album in fuzzy_hits[:5]
                ],
            })
        else:
            new_items.append(item)

        if idx % 100 == 0 or idx == len(candidates):
            print(
                f"  查重进度 {idx}/{len(candidates)} | 明确重复 {len(exact)} | 疑似 {len(suspected)} | 新增 {len(new_items)}",
                flush=True,
            )

    return exact, suspected, new_items


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only dedupe QQ album candidates against BarScope Cloud DB")
    parser.add_argument("--candidates", default="qq_album_candidates.json")
    parser.add_argument("--config", default="config.json")
    parser.add_argument("--output-dir", default=".")
    parser.add_argument("--fuzzy-threshold", type=float, default=0.88)
    args = parser.parse_args()

    candidates_path = Path(args.candidates).expanduser().resolve()
    config_path = Path(args.config).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()

    if not candidates_path.exists():
        print(f"找不到候选文件: {candidates_path}", file=sys.stderr)
        return 2
    if not config_path.exists():
        print(f"找不到配置文件: {config_path}", file=sys.stderr)
        return 2

    payload = load_json(candidates_path)
    candidates = payload.get("results") if isinstance(payload, dict) else payload
    if not isinstance(candidates, list):
        print("候选 JSON 格式不正确：需要 results 数组或顶层数组", file=sys.stderr)
        return 2

    config = load_json(config_path)
    appid = clean(config.get("appid"))
    appsecret = clean(config.get("appsecret"))
    env = clean(config.get("env"))
    if not appid or not appsecret or not env or appid.startswith("<") or appsecret.startswith("<") or env.startswith("<"):
        print("config.json 缺少真实的 appid / appsecret / env", file=sys.stderr)
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"候选数量: {len(candidates)}")
    print("正在只读拉取 BarScope albums 数据库……")
    token = get_access_token(appid, appsecret)
    albums = fetch_all_albums(token, env)
    print(f"数据库专辑数量: {len(albums)}")
    print("开始本地查重……")

    exact, suspected, new_items = dedupe(candidates, albums, args.fuzzy_threshold)

    exact_path = output_dir / "qq_album_dedupe_exact_duplicates.json"
    suspected_path = output_dir / "qq_album_dedupe_suspected_duplicates.json"
    new_path = output_dir / "qq_album_dedupe_new_candidates.json"
    summary_path = output_dir / "qq_album_dedupe_summary.json"

    write_json(exact_path, {"count": len(exact), "results": exact})
    write_json(suspected_path, {"count": len(suspected), "results": suspected})
    write_json(new_path, {"count": len(new_items), "results": new_items})

    summary = {
        "inputCandidates": len(candidates),
        "databaseAlbums": len(albums),
        "exactDuplicates": len(exact),
        "suspectedDuplicates": len(suspected),
        "newCandidates": len(new_items),
        "fuzzyThreshold": args.fuzzy_threshold,
        "readOnly": True,
        "outputs": {
            "exactDuplicates": str(exact_path),
            "suspectedDuplicates": str(suspected_path),
            "newCandidates": str(new_path),
        },
    }
    write_json(summary_path, summary)

    print("\n=== 查重完成 ===")
    print(f"原始候选: {len(candidates)}")
    print(f"数据库专辑: {len(albums)}")
    print(f"明确重复: {len(exact)}")
    print(f"疑似重复: {len(suspected)}")
    print(f"真正新增: {len(new_items)}")
    print(f"汇总文件: {summary_path}")
    print("本次运行只读取数据库，没有新增、修改或删除任何云端数据。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
