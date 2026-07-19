#!/usr/bin/env python3
"""Migrate rappers.json to the BarScope cross-platform artist schema.

The migration is idempotent and keeps legacy `name` / `id` fields so the current
NetEase crawler continues working unchanged.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from artist_identity import ensure_artist_schema


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_FILE = BASE_DIR / "rappers.json"


def migrate(payload: dict) -> tuple[dict, int]:
    rappers = payload.get("rappers", [])
    migrated = []
    changed = 0

    for rapper in rappers:
        updated = ensure_artist_schema(rapper)
        if updated != rapper:
            changed += 1
        migrated.append(updated)

    result = dict(payload)
    result["rappers"] = migrated
    result["schemaVersion"] = 2
    return result, changed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", default=str(DEFAULT_FILE), help="rappers.json path")
    parser.add_argument("--dry-run", action="store_true", help="preview only; do not write")
    args = parser.parse_args()

    path = Path(args.file)
    payload = json.loads(path.read_text(encoding="utf-8"))
    migrated, changed = migrate(payload)

    rappers = migrated.get("rappers", [])
    print(f"Artists: {len(rappers)}")
    print(f"Records changed: {changed}")
    print(f"Schema version: {migrated.get('schemaVersion')}")

    for rapper in rappers[:5]:
        print(
            f"  {rapper.get('name')} | {rapper.get('barscopeArtistId')} | "
            f"NetEase={rapper.get('platforms', {}).get('netease', {}).get('artistId')}"
        )

    if args.dry_run:
        print("\n[dry-run] No file written.")
        return

    backup = path.with_suffix(path.suffix + ".bak")
    if not backup.exists():
        backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"Backup: {backup}")

    path.write_text(json.dumps(migrated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Updated: {path}")


if __name__ == "__main__":
    main()
