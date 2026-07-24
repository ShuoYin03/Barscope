#!/usr/bin/env python3
"""Fast one-pass comparison of qq_album_candidates.json against the live Soundive album library.

Outputs:
- qq_album_need_submit.json       genuinely missing from albums/candidates after strict track filtering
- qq_album_overlap.json           already exists in Soundive albums
- qq_album_already_pending.json   already exists in album_candidates
- qq_album_need_submit_review.csv human-friendly review sheet for the clean missing set
- qq_album_filtered_out.json      missing albums excluded by the strict track rules

Strict track rule for the final submission pool:
- reject the whole album if any track is an accompaniment / instrumental / beat variant
- reject the whole album if duplicate song titles appear in the same album after normalization

This deliberately uses a dedicated bulk-read cloud function instead of the normal upsert/dedupe
path, so 2k-3k candidates can be classified quickly without 3-5 DB round trips per album.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

import requests

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"
DEFAULT_INPUT = BASE_DIR / "qq_album_candidates.json"

VERSION_WORDS = re.compile(
    r"\b(?:explicit|deluxe|extended|remix|version|edition|remaster(?:ed)?|live|instrumental|inst\.?|karaoke|demo)\b",
    re.IGNORECASE,
)
SUSPICIOUS_TITLE_WORDS = [
    "地下8英里", "说唱者联盟", "青春重置计划", "黑怕盲盒", "大声一点hip-hop", "大声一点hiphop",
    "合集", "精选集", "原声", "ost", "现场", "live",
]

# Any one of these signals means the whole album should not enter the QQ submission pool.
# Word boundaries are used for short English tokens so words such as "beatles" are not mistaken
# for a beat/instrumental marker.
ACCOMPANIMENT_RE = re.compile(
    r"(?:"
    r"伴奏|伴奏版|和声伴奏|纯音乐|纯伴奏|无人声|消音版|卡拉ok|卡拉OK|"
    r"\binst\.?\b|\binstrumental\b|\binstrument\s*version\b|"
    r"\bbeat\b|\bbeats\b|\bkaraoke\b|\boff\s*vocal\b|\bvocal\s*less\b"
    r")",
    re.IGNORECASE,
)

# Remove common presentation-only suffixes before checking whether the same song is repeated.
# We intentionally do NOT remove feat/ft guest names, because collaborations can be distinct tracks.
DUPLICATE_SUFFIX_RE = re.compile(
    r"\s*[\(\[（【][^\)\]）】]*(?:explicit|version|remix|remaster(?:ed)?|deluxe|extended|live|demo)[^\)\]）】]*[\)\]）】]\s*$",
    re.IGNORECASE,
)


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


def track_names(item: dict[str, Any]) -> list[str]:
    tracks = item.get("tracks") or []
    return [
        str(x.get("name") or "").strip()
        for x in tracks
        if isinstance(x, dict) and str(x.get("name") or "").strip()
    ]


def normalize_duplicate_track_title(value: str) -> str:
    value = DUPLICATE_SUFFIX_RE.sub("", str(value or "").strip().lower())
    # Explicit is sometimes not wrapped in brackets on QQ Music.
    value = re.sub(r"\bexplicit\b", "", value, flags=re.IGNORECASE)
    return re.sub(r"[\s\-_·•:：,，.!！?？'\"“”‘’()（）\[\]【】/\\]+", "", value)


def strict_track_filter(item: dict[str, Any]) -> tuple[bool, list[str]]:
    """Return (keep, reasons). False removes the whole album from the submission pool."""
    names = track_names(item)
    reasons: list[str] = []

    accompaniment_hits = [name for name in names if ACCOMPANIMENT_RE.search(name)]
    if accompaniment_hits:
        preview = "、".join(accompaniment_hits[:3])
        suffix = f"等{len(accompaniment_hits)}首" if len(accompaniment_hits) > 3 else ""
        reasons.append(f"含伴奏/Inst./Beat类曲目：{preview}{suffix}")

    seen: dict[str, str] = {}
    duplicate_groups: dict[str, list[str]] = {}
    for name in names:
        key = normalize_duplicate_track_title(name)
        if not key:
            continue
        if key in seen:
            duplicate_groups.setdefault(key, [seen[key]]).append(name)
        else:
            seen[key] = name

    if duplicate_groups:
        examples = []
        for group in list(duplicate_groups.values())[:3]:
            examples.append(" / ".join(group[:3]))
        reasons.append("同一专辑存在重复歌曲：" + "；".join(examples))

    return not reasons, reasons


def review_risk(item: dict[str, Any]) -> tuple[str, str, str]:
    """Return (risk, recommendation, reason) for the albums that passed strict filtering."""
    title = str(item.get("title") or "")
    lower = title.lower()
    reasons: list[str] = []
    risk = "低"

    if any(word.lower() in lower for word in SUSPICIOUS_TITLE_WORDS):
        risk = "高"
        reasons.append("标题疑似合集/节目/活动类专辑")

    if VERSION_WORDS.search(title):
        if risk != "高":
            risk = "中"
        reasons.append("标题含版本标记，可能与现有专辑是同一作品的不同平台版本")

    track_count = int(item.get("trackCount") or 0)
    if track_count <= 3:
        if risk == "低":
            risk = "中"
        reasons.append("曲目数较少，建议确认不是单曲/版本包")

    recommendation = "建议提交" if risk == "低" else "人工确认"
    return risk, recommendation, "；".join(dict.fromkeys(reasons)) or "未发现明显风险"


def write_review_csv(path: Path, items: list[dict[str, Any]]) -> Counter:
    rows: list[dict[str, Any]] = []
    risk_counter: Counter = Counter()

    for item in items:
        risk, recommendation, reason = review_risk(item)
        risk_counter[risk] += 1
        names = track_names(item)
        rows.append({
            "审核建议": recommendation,
            "风险等级": risk,
            "艺人": item.get("artist") or item.get("primaryArtist") or "",
            "专辑名": item.get("title") or "",
            "曲目数": item.get("trackCount") or len(names),
            "发行日期": item.get("releaseDate") or "",
            "QQ Album MID": item.get("qqAlbumMid") or item.get("sourceId") or "",
            "QQ Artist MID": item.get("qqArtistMid") or "",
            "网易云 Artist ID": item.get("neteaseArtistId") or "",
            "Soundive Artist ID": item.get("barscopeArtistId") or "",
            "疑似重复/异常原因": reason,
            "曲目预览": " | ".join(names[:8]),
            "封面": item.get("coverUrl") or "",
        })

    order = {"高": 0, "中": 1, "低": 2}
    rows.sort(key=lambda x: (order.get(str(x["风险等级"]), 9), str(x["艺人"]).lower(), str(x["专辑名"]).lower()))

    fieldnames = [
        "审核建议", "风险等级", "艺人", "专辑名", "曲目数", "发行日期",
        "QQ Album MID", "QQ Artist MID", "网易云 Artist ID", "Soundive Artist ID",
        "疑似重复/异常原因", "曲目预览", "封面",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    return risk_counter


def main() -> None:
    parser = argparse.ArgumentParser(description="快速比对 QQ 专辑候选和 Soundive 线上专辑库")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--need-submit-output", default=str(BASE_DIR / "qq_album_need_submit.json"))
    parser.add_argument("--overlap-output", default=str(BASE_DIR / "qq_album_overlap.json"))
    parser.add_argument("--pending-output", default=str(BASE_DIR / "qq_album_already_pending.json"))
    parser.add_argument("--filtered-output", default=str(BASE_DIR / "qq_album_filtered_out.json"))
    parser.add_argument("--review-csv-output", default=str(BASE_DIR / "qq_album_need_submit_review.csv"))
    args = parser.parse_args()

    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    token = get_access_token(str(cfg.get("appid") or ""), str(cfg.get("appsecret") or ""))
    env = str(cfg.get("env") or "")

    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    rows = payload.get("results", []) or []
    by_key = {str(x.get("sourceKey") or f"qq:{x.get('sourceId','')}"): x for x in rows}

    need_submit_raw: list[dict[str, Any]] = []
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
                need_submit_raw.append(item)

        overlap.extend(result.get("matched", []) or [])
        already_pending.extend(result.get("existingCandidates", []) or [])

        print(
            f"[{index}/{len(batches)}] "
            f"需要提交候选 +{result.get('newCount', 0)}  "
            f"库内重合 {result.get('matchedCount', 0)}  "
            f"已在候选 {result.get('existingCandidateCount', 0)}"
        )

    need_submit: list[dict[str, Any]] = []
    filtered_out: list[dict[str, Any]] = []
    for item in need_submit_raw:
        keep, reasons = strict_track_filter(item)
        if keep:
            need_submit.append(item)
        else:
            filtered_out.append({
                **item,
                "filterReason": "；".join(reasons),
                "filteredBy": "strict_track_rule",
            })

    write_payload(Path(args.need_submit_output), "qq_album_need_submit", need_submit)
    write_payload(Path(args.overlap_output), "qq_album_overlap", overlap)
    write_payload(Path(args.pending_output), "qq_album_already_pending", already_pending)
    write_payload(Path(args.filtered_output), "qq_album_filtered_out", filtered_out)
    risk_counts = write_review_csv(Path(args.review_csv_output), need_submit)

    print("\n完成")
    print(f"云端判定需要提交: {len(need_submit_raw)}")
    print(f"严格规则过滤掉:   {len(filtered_out)} -> {args.filtered_output}")
    print(f"最终需要提交:     {len(need_submit)} -> {args.need_submit_output}")
    print(f"与专辑库重合:     {len(overlap)} -> {args.overlap_output}")
    print(f"已在候选区:       {len(already_pending)} -> {args.pending_output}")
    print(f"人工审核表:       {args.review_csv_output}")
    print(
        "审核风险分布: "
        f"高 {risk_counts.get('高', 0)} / 中 {risk_counts.get('中', 0)} / 低 {risk_counts.get('低', 0)}"
    )


if __name__ == "__main__":
    main()
