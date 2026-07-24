#!/usr/bin/env python3
"""Resolve manually-added QQ album rows that have no QQ Album MID.

This is intentionally conservative: it only auto-accepts an exact normalized album-title match
from QQ Music search. The resolved MID is written back into the column that the existing
import_reviewed_qq_albums.py already understands, so the normal ownership resolver can then:

1. read QQ album-level singer credits;
2. map each singer to the existing Soundive / NetEase artist record;
3. import the album under every resolved owner.

Usage:
  python3 resolve_manual_qq_album_mids.py
  python3 import_reviewed_qq_albums.py --csv qq_album_need_submit_resolved.csv --preview
  python3 import_reviewed_qq_albums.py --csv qq_album_need_submit_resolved.csv --commit
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from pathlib import Path
from typing import Any

import requests

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = BASE_DIR / "qq_album_need_submit.csv"
DEFAULT_OUTPUT = BASE_DIR / "qq_album_need_submit_resolved.csv"
DEFAULT_AUDIT = BASE_DIR / "qq_album_manual_resolve_audit.csv"

MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"
SPECIAL_MIDS = {
    "2022wasted": "003hLetz4gRmoa",
    "2022wastedwebsite": "003hLetz4gRmoa",
}


def norm(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    # Explicit is a platform/version marker and should not affect identity matching.
    text = re.sub(r"\bexplicit\b", "", text, flags=re.IGNORECASE)
    return re.sub(r"[\s\-_·•.。'\"“”‘’()（）\[\]【】/\\?!！？，,:：]+", "", text)


def read_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        return list(reader.fieldnames or []), [dict(row) for row in reader]


def write_rows(path: Path, fieldnames: list[str], rows: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def extract_album_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    body = payload.get("req", {}).get("data", {}).get("body", {}) or {}
    block = body.get("album", {}) or {}
    rows = block.get("list", []) or []
    results: list[dict[str, Any]] = []
    for raw in rows:
        album = raw.get("album", raw) if isinstance(raw, dict) else {}
        if not isinstance(album, dict):
            continue
        title = str(
            album.get("albumName")
            or album.get("album_name")
            or album.get("title")
            or album.get("name")
            or ""
        ).strip()
        mid = str(
            album.get("albumMID")
            or album.get("album_mid")
            or album.get("mid")
            or ""
        ).strip()
        album_id = str(
            album.get("albumID")
            or album.get("album_id")
            or album.get("id")
            or ""
        ).strip()

        singers_raw = album.get("singerList") or album.get("singer_list") or album.get("singer") or []
        if isinstance(singers_raw, dict):
            singers_raw = [singers_raw]
        singers: list[dict[str, str]] = []
        for singer in singers_raw if isinstance(singers_raw, list) else []:
            if not isinstance(singer, dict):
                continue
            name = str(singer.get("name") or singer.get("singerName") or singer.get("singer_name") or "").strip()
            singer_mid = str(singer.get("mid") or singer.get("singerMID") or singer.get("singer_mid") or "").strip()
            if name or singer_mid:
                singers.append({"name": name, "mid": singer_mid})

        if title and mid:
            results.append({"title": title, "mid": mid, "albumId": album_id, "singers": singers})
    return results


def search_qq_albums(title: str, limit: int = 20) -> list[dict[str, Any]]:
    payload = {
        "comm": {"ct": "19", "cv": "1859", "uin": "0"},
        "req": {
            "module": "music.search.SearchCgiService",
            "method": "DoSearchForQQMusicDesktop",
            "param": {
                "query": title,
                "search_type": 2,
                "num_per_page": max(1, min(limit, 30)),
                "page_num": 1,
            },
        },
    }
    response = requests.post(
        MUSICU_URL,
        json=payload,
        timeout=20,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
            "Referer": "https://y.qq.com/",
            "Origin": "https://y.qq.com",
        },
    )
    response.raise_for_status()
    return extract_album_rows(response.json())


def choose_exact(title: str, results: list[dict[str, Any]]) -> dict[str, Any] | None:
    wanted = norm(title)
    exact = [item for item in results if norm(item.get("title")) == wanted]
    if len(exact) == 1:
        return exact[0]
    # If multiple exact-name editions exist, keep the first but make the ambiguity visible in audit.
    if exact:
        picked = dict(exact[0])
        picked["ambiguousExactCount"] = len(exact)
        return picked
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="为手动补入的 QQ 专辑按标题反查 QQ Album MID")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--audit", default=str(DEFAULT_AUDIT))
    args = parser.parse_args()

    input_path = Path(args.input)
    fieldnames, rows = read_rows(input_path)
    if "QQ Album ID" not in fieldnames:
        fieldnames.append("QQ Album ID")
    if "QQ Album MID" not in fieldnames:
        fieldnames.append("QQ Album MID")

    audit: list[dict[str, Any]] = []
    resolved_count = 0
    unresolved_count = 0

    for idx, row in enumerate(rows, 1):
        title = str(row.get("QQ专辑名") or row.get("专辑名") or "").strip()
        current_mid = str(row.get("QQ Album MID") or "").strip()
        current_id = str(row.get("QQ Album ID") or "").strip()

        if re.fullmatch(r"[A-Za-z0-9]{14}", current_mid):
            audit.append({"QQ专辑名": title, "解析状态": "已有MID", "QQ Album MID": current_mid, "QQ艺人归属": ""})
            continue
        if re.fullmatch(r"[A-Za-z0-9]{14}", current_id):
            row["QQ Album MID"] = current_id
            audit.append({"QQ专辑名": title, "解析状态": "已有MID", "QQ Album MID": current_id, "QQ艺人归属": ""})
            continue

        special = SPECIAL_MIDS.get(norm(title))
        if special:
            row["QQ Album MID"] = special
            row["QQ Album ID"] = special
            resolved_count += 1
            audit.append({
                "QQ专辑名": title,
                "解析状态": "手动指定",
                "QQ Album MID": special,
                "QQ艺人归属": "张方钊",
                "备注": "使用用户提供的 QQ 音乐专辑链接",
            })
            print(f"  [{idx}/{len(rows)}] ✓ {title} -> {special} [手动指定]")
            continue

        try:
            results = search_qq_albums(title)
            chosen = choose_exact(title, results)
        except Exception as exc:
            chosen = None
            results = []
            error = str(exc)
        else:
            error = ""

        if chosen:
            mid = str(chosen.get("mid") or "").strip()
            row["QQ Album MID"] = mid
            # import_reviewed_qq_albums.py historically reads QQ Album ID first; mirror MID there too
            # so manually-added rows flow through the existing importer without ambiguity.
            row["QQ Album ID"] = mid
            singer_names = [str(x.get("name") or "").strip() for x in chosen.get("singers", []) if str(x.get("name") or "").strip()]
            resolved_count += 1
            audit.append({
                "QQ专辑名": title,
                "解析状态": "精确标题匹配" if not chosen.get("ambiguousExactCount") else "精确标题匹配-存在同名版本",
                "QQ Album MID": mid,
                "QQ艺人归属": " / ".join(singer_names),
                "备注": f"QQ搜索同名结果 {chosen.get('ambiguousExactCount', 1)} 个",
            })
            print(f"  [{idx}/{len(rows)}] ✓ {title} -> {mid} · {' / '.join(singer_names) or '待详情页读取艺人'}")
        else:
            unresolved_count += 1
            previews = " | ".join(str(x.get("title") or "") for x in results[:5])
            audit.append({
                "QQ专辑名": title,
                "解析状态": "未找到精确标题",
                "QQ Album MID": "",
                "QQ艺人归属": "",
                "备注": error or (f"QQ搜索前5项: {previews}" if previews else "QQ搜索无结果"),
            })
            print(f"  [{idx}/{len(rows)}] ✗ {title} · 未找到精确同名 QQ 专辑")

    write_rows(Path(args.output), fieldnames, rows)
    write_rows(Path(args.audit), ["QQ专辑名", "解析状态", "QQ Album MID", "QQ艺人归属", "备注"], audit)

    print("\n完成")
    print(f"  新解析 MID: {resolved_count}")
    print(f"  仍未解析:   {unresolved_count}")
    print(f"  可供导入:   {args.output}")
    print(f"  解析审核:   {args.audit}")
    print("\n下一步先预览归属：")
    print(f"  python3 import_reviewed_qq_albums.py --csv {Path(args.output).name} --preview")


if __name__ == "__main__":
    main()
