#!/usr/bin/env python3
"""Inspect QQ Music album-detail payloads without dumping unrelated secrets.

Usage:
    python3 debug_qq_album_payload.py 000e3zcD2sSgfP
"""

from __future__ import annotations

import argparse
import json
from typing import Any

from qqmusic_client import QQMusicClient


DATE_HINTS = ("date", "time", "pub", "publish", "release")


def walk(value: Any, path: str = "root") -> list[tuple[str, Any]]:
    matches: list[tuple[str, Any]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if any(hint in key.lower() for hint in DATE_HINTS):
                matches.append((child_path, child))
            matches.extend(walk(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value[:20]):
            matches.extend(walk(child, f"{path}[{index}]"))
    return matches


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect QQ album detail response fields")
    parser.add_argument("album_mid", help="QQ Album MID")
    args = parser.parse_args()

    client = QQMusicClient()
    payload = client._get_legacy_album_payload(args.album_mid)  # diagnostic only

    print("Top-level keys:", list(payload.keys()))
    data = payload.get("data")
    if isinstance(data, dict):
        print("data keys:", list(data.keys()))

    print("\nPossible date/time fields:")
    matches = walk(payload)
    if not matches:
        print("  (none found by key name)")
    else:
        for path, value in matches[:100]:
            preview = repr(value)
            if len(preview) > 500:
                preview = preview[:500] + "..."
            print(f"  {path} = {preview}")

    print("\nRaw payload preview:")
    raw = json.dumps(payload, ensure_ascii=False, indent=2)
    print(raw[:12000])


if __name__ == "__main__":
    main()
