#!/usr/bin/env python3
"""Re-apply the current matched/review/unmatched threshold to already-fetched evidence.

resolve_qq_artist_candidates.py's output already stores, per artist, every evaluated
candidate's match evidence (matched_tracks / track_overlap / name_similarity) — no need to
re-fetch anything from QQ Music or NetEase to try a looser or stricter bar. This re-ranks
each artist's evaluatedCandidates using artist_resolver.classify_match() and upgrades
resolutionStatus/bestCandidate for rows that now qualify. Rows with zero candidates found
(status "error"/no candidates at all) are left untouched — there's no evidence to reclassify.

Usage:
  python3 reclassify_qq_artist_matches.py --input qq_artist_matches.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from artist_resolver import classify_match

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = BASE_DIR / "qq_artist_matches.json"
DEFAULT_OUTPUT = BASE_DIR / "qq_artist_matches_reclassified.json"


def reclassify_row(row: dict) -> dict:
    evaluated = row.get("evaluatedCandidates") or []
    if not evaluated:
        return row

    rescored = []
    for candidate in evaluated:
        match = candidate.get("match")
        if not match:
            rescored.append(candidate)
            continue
        status = classify_match(
            int(match.get("matched_tracks") or 0),
            float(match.get("track_overlap") or 0),
            float(match.get("name_similarity") or 0),
        )
        rescored.append({**candidate, "match": {**match, "status": status}})

    ranked = sorted(
        (item for item in rescored if item.get("match")),
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

    # Same tie-break as resolve_qq_artist_candidates.py: don't auto-bind when two candidates
    # are effectively tied — common with duplicate/abandoned same-named accounts.
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
    elif best_status in ("matched", "review"):
        resolution_status = best_status
    else:
        resolution_status = "unmatched"

    return {**row, "resolutionStatus": resolution_status, "bestCandidate": best, "evaluatedCandidates": rescored}


def main() -> None:
    parser = argparse.ArgumentParser(description="用当前判定阈值，重新给已经抓过曲目证据的候选打分（不联网，不重新爬取）")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()

    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    rows = payload.get("results", []) or []

    def count_by_status(items: list[dict]) -> dict:
        counts: dict[str, int] = {}
        for row in items:
            status = row.get("resolutionStatus", "unmatched")
            counts[status] = counts.get(status, 0) + 1
        return counts

    before = count_by_status(rows)

    upgraded: list[tuple[str, str, str]] = []
    reclassified_rows = []
    for row in rows:
        if row.get("resolutionStatus") == "error":
            reclassified_rows.append(row)
            continue
        new_row = reclassify_row(row)
        if new_row.get("resolutionStatus") != row.get("resolutionStatus"):
            upgraded.append((str(row.get("displayName") or ""), str(row.get("resolutionStatus")), str(new_row.get("resolutionStatus"))))
        reclassified_rows.append(new_row)

    after = count_by_status(reclassified_rows)

    output_payload = {
        "schemaVersion": 1,
        "source": "qqmusic_artist_catalogue_resolution",
        "artistCount": len(reclassified_rows),
        "summary": after,
        "results": reclassified_rows,
    }
    Path(args.output).write_text(json.dumps(output_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"重新分类前：{before}")
    print(f"重新分类后：{after}")
    print(f"\n状态发生变化的艺人（{len(upgraded)} 位）：")
    for name, old, new in upgraded[:50]:
        print(f"  {name}: {old} -> {new}")
    if len(upgraded) > 50:
        print(f"  ...还有 {len(upgraded) - 50} 位")
    print(f"\n已写回 -> {args.output}")
    print("确认没问题的话，可以直接拿这份文件去跑 link_qq_artist_ids.py --matches " + str(args.output))


if __name__ == "__main__":
    main()
