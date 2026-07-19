#!/usr/bin/env python3
"""Resolve QQ Music artist candidates by catalogue overlap with NetEase Music."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from artist_resolver import resolve_artist_match
from netease_client import NetEaseMusicClient, NetEaseMusicError
from qqmusic_client import QQMusicClient, QQMusicError


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CANDIDATES = BASE_DIR / "qq_artist_candidates.json"
DEFAULT_OUTPUT = BASE_DIR / "qq_artist_matches.json"


def load_candidate_file(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_rows(
    rows: list[dict],
    *,
    qq_limit: int = 200,
    netease_limit: int = 100,
    sleep_seconds: float = 0.25,
) -> list[dict]:
    qq = QQMusicClient()
    netease = NetEaseMusicClient()
    resolved: list[dict] = []

    for index, row in enumerate(rows, start=1):
        display_name = str(row.get("displayName") or "").strip()
        netease_artist_id = row.get("neteaseArtistId")
        candidates = row.get("candidates", []) or []

        print(f"[{index}/{len(rows)}] {display_name}")

        if not netease_artist_id:
            resolved.append(
                {
                    **row,
                    "resolutionStatus": "error",
                    "resolutionError": "missing NetEase artist ID",
                    "evaluatedCandidates": [],
                }
            )
            continue

        try:
            netease_tracks = netease.get_artist_tracks(netease_artist_id, limit=netease_limit)
        except (NetEaseMusicError, OSError, ValueError) as exc:
            resolved.append(
                {
                    **row,
                    "resolutionStatus": "error",
                    "resolutionError": f"NetEase tracks: {exc}",
                    "evaluatedCandidates": [],
                }
            )
            continue

        evaluated: list[dict] = []
        for candidate in candidates:
            singer_mid = str(candidate.get("mid") or "").strip()
            if not singer_mid:
                continue

            try:
                qq_tracks = qq.get_artist_tracks(singer_mid, limit=qq_limit)
                match = resolve_artist_match(
                    netease_tracks,
                    qq_tracks,
                    netease_name=display_name,
                    qq_name=str(candidate.get("name") or ""),
                )
                evaluated.append(
                    {
                        **candidate,
                        "qqFetchedTrackCount": len(qq_tracks),
                        "match": match.to_dict(),
                    }
                )
            except (QQMusicError, OSError, ValueError) as exc:
                evaluated.append(
                    {
                        **candidate,
                        "qqFetchedTrackCount": 0,
                        "match": None,
                        "error": str(exc),
                    }
                )

            if sleep_seconds > 0:
                time.sleep(sleep_seconds)

        ranked = sorted(
            (item for item in evaluated if item.get("match")),
            key=lambda item: (
                item["match"]["track_overlap"],
                item["match"]["matched_tracks"],
                item["match"]["score"],
                item.get("nameScore", 0),
            ),
            reverse=True,
        )
        best = ranked[0] if ranked else None
        best_status = best["match"]["status"] if best else "unmatched"

        # Avoid auto-binding when two candidates are effectively tied. This is common
        # with duplicate or abandoned artist accounts carrying the same display name.
        ambiguous = False
        if len(ranked) >= 2:
            first = ranked[0]["match"]
            second = ranked[1]["match"]
            ambiguous = (
                first["matched_tracks"] == second["matched_tracks"]
                and abs(first["track_overlap"] - second["track_overlap"]) < 0.05
            )

        if ambiguous and best_status == "matched":
            resolution_status = "review"
        elif best_status == "matched":
            resolution_status = "matched"
        elif best_status == "review":
            resolution_status = "review"
        else:
            resolution_status = "unmatched"

        resolved.append(
            {
                "barscopeArtistId": row.get("barscopeArtistId"),
                "displayName": display_name,
                "neteaseArtistId": netease_artist_id,
                "neteaseFetchedTrackCount": len(netease_tracks),
                "resolutionStatus": resolution_status,
                "bestCandidate": best,
                "evaluatedCandidates": evaluated,
            }
        )

    return resolved


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=str(DEFAULT_CANDIDATES))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--qq-limit", type=int, default=200)
    parser.add_argument("--netease-limit", type=int, default=100)
    parser.add_argument("--sleep", type=float, default=0.25)
    args = parser.parse_args()

    payload = load_candidate_file(Path(args.input))
    rows = payload.get("results", []) or []
    resolved = resolve_rows(
        rows,
        qq_limit=max(1, args.qq_limit),
        netease_limit=max(1, args.netease_limit),
        sleep_seconds=max(0.0, args.sleep),
    )

    summary = {
        "matched": sum(1 for row in resolved if row["resolutionStatus"] == "matched"),
        "review": sum(1 for row in resolved if row["resolutionStatus"] == "review"),
        "unmatched": sum(1 for row in resolved if row["resolutionStatus"] == "unmatched"),
        "error": sum(1 for row in resolved if row["resolutionStatus"] == "error"),
    }
    output_payload = {
        "schemaVersion": 1,
        "source": "qqmusic_artist_catalogue_resolution",
        "artistCount": len(resolved),
        "summary": summary,
        "results": resolved,
    }

    output = Path(args.output)
    output.write_text(json.dumps(output_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nSummary: {summary}")
    print(f"Saved {len(resolved)} artist resolutions -> {output}")


if __name__ == "__main__":
    main()
