#!/usr/bin/env python3
"""Search QQ Music candidates for every BarScope artist.

Default behaviour is deliberately safe: write a separate review file and do not
modify rappers.json. Confirmed mappings can be merged later by the resolver step.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from artist_identity import normalise_artist_name
from qqmusic_client import QQMusicClient, QQMusicError


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_ARTISTS = BASE_DIR / "rappers.json"
DEFAULT_OUTPUT = BASE_DIR / "qq_artist_candidates.json"


def load_artists(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload.get("rappers", [])


def candidate_name_score(source_name: str, candidate_name: str) -> float:
    left = normalise_artist_name(source_name)
    right = normalise_artist_name(candidate_name)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    if left in right or right in left:
        return 0.85
    # Cheap character overlap pre-score. Track overlap remains the real resolver signal.
    union = set(left) | set(right)
    return round(len(set(left) & set(right)) / len(union), 4) if union else 0.0


def crawl(
    artists: list[dict],
    *,
    limit: int,
    sleep_seconds: float,
    start: int = 0,
    count: int | None = None,
) -> dict:
    client = QQMusicClient()
    selected = artists[start : start + count if count is not None else None]
    rows: list[dict] = []

    for index, artist in enumerate(selected, start=start + 1):
        name = str(artist.get("name") or artist.get("displayName") or "").strip()
        barscope_id = str(artist.get("barscopeArtistId") or "").strip()
        if not name or not barscope_id:
            continue

        print(f"[{index}/{len(artists)}] {name}")
        try:
            candidates = client.search_artists(name, limit=limit)
            candidate_rows = []
            for candidate in candidates:
                row = candidate.to_dict()
                row["nameScore"] = candidate_name_score(name, candidate.name)
                candidate_rows.append(row)

            rows.append(
                {
                    "barscopeArtistId": barscope_id,
                    "displayName": name,
                    "neteaseArtistId": artist.get("platforms", {}).get("netease", {}).get("artistId"),
                    "status": "candidates_found" if candidate_rows else "no_candidate",
                    "candidates": candidate_rows,
                }
            )
        except (QQMusicError, OSError, ValueError) as exc:
            print(f"  ERROR: {exc}")
            rows.append(
                {
                    "barscopeArtistId": barscope_id,
                    "displayName": name,
                    "status": "error",
                    "error": str(exc),
                    "candidates": [],
                }
            )

        if sleep_seconds > 0:
            time.sleep(sleep_seconds)

    return {
        "schemaVersion": 1,
        "source": "qqmusic_artist_search",
        "artistCount": len(rows),
        "results": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artists", default=str(DEFAULT_ARTISTS))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--limit", type=int, default=5, help="QQ candidates per artist")
    parser.add_argument("--sleep", type=float, default=0.35, help="delay between artist searches")
    parser.add_argument("--start", type=int, default=0, help="zero-based start offset")
    parser.add_argument("--count", type=int, default=None, help="number of artists to process")
    args = parser.parse_args()

    artists = load_artists(Path(args.artists))
    result = crawl(
        artists,
        limit=max(1, args.limit),
        sleep_seconds=max(0.0, args.sleep),
        start=max(0, args.start),
        count=args.count if args.count is None else max(0, args.count),
    )

    output = Path(args.output)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nSaved {result['artistCount']} artist results -> {output}")


if __name__ == "__main__":
    main()
