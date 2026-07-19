#!/usr/bin/env python3

import sys
import unittest
from pathlib import Path


CRAWLER_DIR = Path(__file__).resolve().parents[1]
if str(CRAWLER_DIR) not in sys.path:
    sys.path.insert(0, str(CRAWLER_DIR))

from artist_resolver import resolve_artist_match


class ArtistResolutionTests(unittest.TestCase):
    def test_clear_catalogue_match(self):
        result = resolve_artist_match(
            ["Track A", "Track B", "Track C", "Track D"],
            ["Track A", "Track B", "Track C", "Other"],
            "Artist",
            "Artist",
        )
        # 75% overlap + matched >= 3 + identical names clears the combined-evidence
        # auto-match rule in resolve_artist_match.
        self.assertEqual(result.status, "matched")
        self.assertEqual(result.matched_tracks, 3)
        self.assertAlmostEqual(result.track_overlap, 0.75)

    def test_auto_match_above_eighty_percent(self):
        result = resolve_artist_match(
            ["A", "B", "C", "D", "E"],
            ["A", "B", "C", "D", "X"],
            "TOYOKI",
            "TOYOKI",
        )
        self.assertEqual(result.status, "matched")
        self.assertEqual(result.matched_tracks, 4)
        self.assertAlmostEqual(result.track_overlap, 0.8)

    def test_name_only_does_not_auto_match(self):
        result = resolve_artist_match(
            ["A", "B", "C"],
            ["X", "Y", "Z"],
            "Same Name",
            "Same Name",
        )
        self.assertEqual(result.status, "unmatched")
        self.assertEqual(result.matched_tracks, 0)


if __name__ == "__main__":
    unittest.main()
