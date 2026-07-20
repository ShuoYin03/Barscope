#!/usr/bin/env python3
"""Deep second-pass refinement for the QQ-only album submission pool.

This pass is intentionally stricter than the fast comparer:
1. Re-fetch QQ album detail so missing QQ release dates are filled.
2. Re-run BarScope comparison with the enriched release date; same mapped artist + NetEase
   release date within +/- 3 days is treated as an existing album even when titles differ.
3. Reject obvious programme / competition / campaign / compilation projects.
4. Reject albums whose tracks have no stable owning artist across the record (multi-artist project).
5. Reject likely QQ artist mis-assignment when the mapped QQ singer barely appears in the tracks.
6. Support a manual non-Chinese / wrong-identity blacklist for cases nationality cannot be inferred
   safely from an English stage name alone.

Outputs overwrite the clean submission pool by default and preserve every removed row with reasons.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from collections import Counter
from pathlib import Path
from typing import Any

import requests

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"
MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"
LEGACY_ALBUM_INFO_URL = "https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg"

PROJECT_RE = re.compile(
    r"(?:说唱梦工厂|特别说唱企划|说唱企划|企划|地下8英里|说唱者联盟|青春重置计划|"
    r"黑怕盲盒|大声一点\s*hip-?hop|音乐节|专场|赛事|赛季|决赛|半决赛|比赛|周年企划|"
    r"三周年|群星|合辑|精选集|原声带|ost|综艺|节目|cypher\s*合集|厂牌合集)",
    re.IGNORECASE,
)

PUBLISH_KEYS = (
    "pub_time", "publish_date", "publishDate", "publicTime", "publictime",
    "release_date", "releaseDate", "date", "time_public",
)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


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


def invoke_compare(token: str, env: str, batch: list[dict[str, Any]]) -> dict[str, Any]:
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


def find_publish_date(value: Any) -> str:
    if isinstance(value, dict):
        for key in PUBLISH_KEYS:
            raw = value.get(key)
            if raw is not None:
                text = str(raw).strip()
                if re.search(r"(?:19|20)\d{2}", text):
                    return text
        for child in value.values():
            found = find_publish_date(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_publish_date(child)
            if found:
                return found
    return ""


def album_detail(session: requests.Session, album_mid: str) -> dict[str, Any]:
    r = session.get(
        LEGACY_ALBUM_INFO_URL,
        params={"albummid": album_mid, "format": "json", "platform": "yqq", "newsong": 1},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def musicu_tracks(session: requests.Session, album_mid: str, limit: int = 500) -> list[dict[str, Any]]:
    payload = {
        "comm": {"ct": 24, "cv": 0},
        "albumSongList": {
            "module": "music.musichallAlbum.AlbumSongList",
            "method": "GetAlbumSongList",
            "param": {"albumMid": album_mid, "begin": 0, "num": max(1, min(limit, 500)), "order": 2},
        },
    }
    r = session.post(MUSICU_URL, json=payload, timeout=20)
    r.raise_for_status()
    data = r.json()
    body = (data.get("albumSongList", {}) or {}).get("data", {}) or {}
    for key in ("songList", "list", "songs"):
        rows = body.get(key, []) or []
        if rows:
            return rows
    return []


def unwrap_song(row: Any) -> dict[str, Any]:
    if not isinstance(row, dict):
        return {}
    song = row.get("songInfo") or row.get("songinfo") or row.get("musicData") or row.get("data") or row
    return song if isinstance(song, dict) else {}


def extract_track_identity(row: Any) -> dict[str, Any]:
    song = unwrap_song(row)
    title = str(song.get("title") or song.get("songname") or song.get("songName") or song.get("name") or "").strip()
    singers = song.get("singer") or song.get("singers") or song.get("artist") or song.get("artists") or []
    if isinstance(singers, dict):
        singers = [singers]
    names: list[str] = []
    mids: list[str] = []
    for singer in singers if isinstance(singers, list) else []:
        if not isinstance(singer, dict):
            continue
        name = str(singer.get("name") or singer.get("singerName") or singer.get("title") or "").strip()
        mid = str(singer.get("mid") or singer.get("singerMid") or singer.get("singerMID") or "").strip()
        if name:
            names.append(name)
        if mid:
            mids.append(mid)
    return {"name": title, "artistNames": names, "artistMids": mids}


def normalized_name(value: str) -> str:
    return re.sub(r"[\s\-_.·•'\"“”‘’()（）\[\]【】]+", "", str(value or "").lower())


def load_blacklist(path: Path | None) -> set[str]:
    if not path or not path.exists():
        return set()
    payload = load_json(path)
    rows = payload.get("artists", payload if isinstance(payload, list) else [])
    return {normalized_name(str(x)) for x in rows if str(x).strip()}


def classify_album(item: dict[str, Any], tracks: list[dict[str, Any]], blacklist: set[str]) -> list[str]:
    reasons: list[str] = []
    title = str(item.get("title") or "")
    artist = str(item.get("artist") or item.get("primaryArtist") or "")
    expected_mid = str(item.get("qqArtistMid") or "").strip()

    if PROJECT_RE.search(title):
        reasons.append("活动/比赛/企划/合集类专辑")

    if normalized_name(artist) in blacklist:
        reasons.append("非中国艺人或已确认错误艺人映射")

    identities = [extract_track_identity(row) for row in tracks]
    identities = [x for x in identities if x.get("name")]
    if not identities:
        return reasons

    all_mids: set[str] = set()
    all_names: set[str] = set()
    appearances_mid: Counter = Counter()
    appearances_name: Counter = Counter()

    for track in identities:
        mids = set(track.get("artistMids") or [])
        names = {normalized_name(x) for x in track.get("artistNames") or [] if normalized_name(x)}
        all_mids.update(mids)
        all_names.update(names)
        for mid in mids:
            appearances_mid[mid] += 1
        for name in names:
            appearances_name[name] += 1

    total = len(identities)
    expected_name = normalized_name(artist)
    owner_hits = appearances_mid.get(expected_mid, 0) if expected_mid else 0
    if not owner_hits and expected_name:
        owner_hits = appearances_name.get(expected_name, 0)

    # A real artist album normally has a stable anchor artist across the tracklist. Project albums
    # instead rotate unrelated lead artists and have no artist appearing on most songs.
    top_hits = 0
    if appearances_mid:
        top_hits = max(top_hits, max(appearances_mid.values()))
    if appearances_name:
        top_hits = max(top_hits, max(appearances_name.values()))

    distinct_artists = len(all_mids) if all_mids else len(all_names)
    anchor_ratio = top_hits / total if total else 0
    owner_ratio = owner_hits / total if total else 0

    if total >= 4 and distinct_artists >= 4 and anchor_ratio < 0.60:
        reasons.append(f"多主唱企划：{distinct_artists}位艺人轮换，最高共同主唱覆盖仅{anchor_ratio:.0%}")

    # Catch QQ artist-page ownership mistakes: the mapped artist is absent from most of the album.
    if total >= 4 and expected_mid and owner_ratio < 0.40:
        reasons.append(f"QQ艺人归属疑似错误：目标艺人仅出现在{owner_hits}/{total}首")

    return reasons


def main() -> None:
    parser = argparse.ArgumentParser(description="深度缩小 QQ 专辑提交池：补日期、多主唱企划、错误艺人归属")
    parser.add_argument("--input", default=str(BASE_DIR / "qq_album_need_submit.json"))
    parser.add_argument("--output", default=str(BASE_DIR / "qq_album_need_submit.json"))
    parser.add_argument("--filtered-output", default=str(BASE_DIR / "qq_album_deep_filtered_out.json"))
    parser.add_argument("--overlap-output", default=str(BASE_DIR / "qq_album_overlap_by_date.json"))
    parser.add_argument("--blacklist", default=str(BASE_DIR / "qq_non_chinese_artist_blacklist.json"))
    parser.add_argument("--sleep", type=float, default=0.05)
    parser.add_argument("--batch-size", type=int, default=100)
    args = parser.parse_args()

    source = load_json(Path(args.input))
    rows = source.get("results", []) or []
    cfg = load_json(CONFIG_FILE)
    token = get_access_token(str(cfg.get("appid") or ""), str(cfg.get("appsecret") or ""))
    env = str(cfg.get("env") or "")
    blacklist = load_blacklist(Path(args.blacklist))

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",
        "Referer": "https://y.qq.com/",
        "Origin": "https://y.qq.com",
    })

    enriched: list[dict[str, Any]] = []
    filtered: list[dict[str, Any]] = []

    print(f"开始深度复核 {len(rows)} 张专辑……")
    for idx, item in enumerate(rows, 1):
        album_mid = str(item.get("qqAlbumMid") or item.get("sourceId") or "").strip()
        work = dict(item)
        tracks_raw: list[dict[str, Any]] = []
        try:
            if album_mid:
                detail = album_detail(session, album_mid)
                if not work.get("releaseDate"):
                    work["releaseDate"] = find_publish_date(detail)
                tracks_raw = musicu_tracks(session, album_mid)
                detailed = [extract_track_identity(x) for x in tracks_raw]
                if detailed:
                    work["tracksDetailed"] = detailed
        except Exception as exc:  # keep the row if QQ temporarily fails; never delete on network failure
            work["deepRefineWarning"] = str(exc)

        reasons = classify_album(work, tracks_raw, blacklist)
        if reasons:
            filtered.append({**work, "filterReason": "；".join(reasons), "filteredBy": "deep_refine_rule"})
        else:
            enriched.append(work)

        if idx % 25 == 0 or idx == len(rows):
            print(f"  QQ复核 {idx}/{len(rows)} · 保留 {len(enriched)} · 过滤 {len(filtered)}")
        if args.sleep:
            time.sleep(args.sleep)

    # Re-run the live BarScope comparer after release dates have been enriched. The cloud function
    # uses the NetEase album date as benchmark and accepts +/- 3 days for the same mapped artist.
    by_key = {str(x.get("sourceKey") or f"qq:{x.get('sourceId','')}"): x for x in enriched}
    still_new: list[dict[str, Any]] = []
    date_overlap: list[dict[str, Any]] = []
    batch_size = max(20, min(int(args.batch_size), 200))
    batches = [enriched[i:i + batch_size] for i in range(0, len(enriched), batch_size)]
    for idx, batch in enumerate(batches, 1):
        result = invoke_compare(token, env, batch)
        for key in result.get("newItems", []) or []:
            item = by_key.get(str(key))
            if item:
                still_new.append(item)
        date_overlap.extend(result.get("matched", []) or [])
        print(f"  日期/库内复核 {idx}/{len(batches)} · 仍需提交 {len(still_new)} · 新识别重合 {len(date_overlap)}")

    Path(args.output).write_text(
        json.dumps({"source": "qq_album_need_submit_deep_refined", "count": len(still_new), "results": still_new}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    Path(args.filtered_output).write_text(
        json.dumps({"source": "qq_album_deep_filtered_out", "count": len(filtered), "results": filtered}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    Path(args.overlap_output).write_text(
        json.dumps({"source": "qq_album_overlap_by_date", "count": len(date_overlap), "results": date_overlap}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("\n完成")
    print(f"深度规则过滤: {len(filtered)} -> {args.filtered_output}")
    print(f"日期/现有库重合: {len(date_overlap)} -> {args.overlap_output}")
    print(f"最终需要提交: {len(still_new)} -> {args.output}")
    if not blacklist:
        print("提示：未加载非中国艺人黑名单；国籍不能仅凭英文艺名可靠判断，错误QQ归属仍会按曲目主唱覆盖率自动过滤。")


if __name__ == "__main__":
    main()
