#!/usr/bin/env python3
"""Local-only QQ album candidate dedupe.

Reads an exported BarScope albums JSON/JSONL file and qq_album_candidates.json.
Does not require WeChat AppSecret and never accesses or modifies Cloud DB.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

from dedupe_qq_album_candidates import dedupe, load_json, write_json


def extract_rows(payload: Any) -> List[Dict[str, Any]]:
    """Accept common CloudBase export JSON shapes and plain arrays."""
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]

    if isinstance(payload, dict):
        for key in ("results", "data", "records", "items", "list"):
            value = payload.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]

        # Some exports wrap the actual payload one level deeper.
        for value in payload.values():
            if isinstance(value, list) and all(isinstance(x, dict) for x in value):
                return value

        # A single document is also a valid one-row export payload.
        return [payload]

    raise ValueError("无法识别 JSON 格式")


def load_export_rows(path: Path) -> List[Dict[str, Any]]:
    """Load normal JSON, JSON Lines, or multiple concatenated JSON documents."""
    text = path.read_text(encoding="utf-8-sig").strip()
    if not text:
        return []

    # 1) Standard JSON array/object.
    try:
        return extract_rows(json.loads(text))
    except json.JSONDecodeError:
        pass

    # 2) CloudBase exports are often JSONL: one complete document per line.
    rows: List[Dict[str, Any]] = []
    jsonl_ok = True
    for line_no, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            jsonl_ok = False
            break
        try:
            rows.extend(extract_rows(payload))
        except ValueError as exc:
            raise ValueError(f"第 {line_no} 行格式无法识别: {exc}") from exc
    if jsonl_ok and rows:
        return rows

    # 3) Fallback for JSON documents concatenated without newline boundaries.
    decoder = json.JSONDecoder()
    rows = []
    pos = 0
    length = len(text)
    while pos < length:
        while pos < length and text[pos].isspace():
            pos += 1
        if pos >= length:
            break
        try:
            payload, end = decoder.raw_decode(text, pos)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"既不是标准 JSON，也不是可识别的 JSONL/连续 JSON；"
                f"错误位置 line {exc.lineno} column {exc.colno}: {exc.msg}"
            ) from exc
        rows.extend(extract_rows(payload))
        pos = end

    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Local-only dedupe QQ album candidates against exported BarScope albums JSON")
    parser.add_argument("--candidates", default="qq_album_candidates.json")
    parser.add_argument("--albums-file", default="0719-albumdatabase.json")
    parser.add_argument("--output-dir", default=".")
    parser.add_argument("--fuzzy-threshold", type=float, default=0.88)
    args = parser.parse_args()

    candidates_path = Path(args.candidates).expanduser().resolve()
    albums_path = Path(args.albums_file).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()

    if not candidates_path.exists():
        print(f"找不到候选文件: {candidates_path}", file=sys.stderr)
        return 2
    if not albums_path.exists():
        print(f"找不到本地专辑数据库文件: {albums_path}", file=sys.stderr)
        return 2

    try:
        candidate_payload = load_json(candidates_path)
        candidates = extract_rows(candidate_payload)
        albums = load_export_rows(albums_path)
    except Exception as exc:
        print(f"读取 JSON 失败: {exc}", file=sys.stderr)
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"候选数量: {len(candidates)}")
    print(f"本地数据库专辑数量: {len(albums)}")
    print("开始本地查重……")

    exact, suspected, new_items = dedupe(candidates, albums, args.fuzzy_threshold)

    exact_path = output_dir / "qq_album_dedupe_exact_duplicates.json"
    suspected_path = output_dir / "qq_album_dedupe_suspected_duplicates.json"
    new_path = output_dir / "qq_album_dedupe_new_candidates.json"
    summary_path = output_dir / "qq_album_dedupe_summary.json"

    write_json(exact_path, {"count": len(exact), "results": exact})
    write_json(suspected_path, {"count": len(suspected), "results": suspected})
    write_json(new_path, {"count": len(new_items), "results": new_items})
    write_json(summary_path, {
        "inputCandidates": len(candidates),
        "databaseAlbums": len(albums),
        "exactDuplicates": len(exact),
        "suspectedDuplicates": len(suspected),
        "newCandidates": len(new_items),
        "fuzzyThreshold": args.fuzzy_threshold,
        "source": "local_export",
        "albumsFile": str(albums_path),
        "readOnly": True,
    })

    print("\n=== 查重完成 ===")
    print(f"原始候选: {len(candidates)}")
    print(f"数据库专辑: {len(albums)}")
    print(f"明确重复: {len(exact)}")
    print(f"疑似重复: {len(suspected)}")
    print(f"真正新增: {len(new_items)}")
    print(f"汇总文件: {summary_path}")
    print("本次运行完全在本地完成，没有访问、修改或删除任何云端数据。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
