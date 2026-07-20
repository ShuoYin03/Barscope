#!/usr/bin/env python3

import unittest

from artist_resolver import resolve_artist_match


class ArtistResolverTests(unittest.TestCase):
    def test_overlap_uses_smaller_catalogue(self):
        netease = [f"Song {i}" for i in range(10)]
        qq = [f"Song {i}" for i in range(9)] + [f"QQ Exclusive {i}" for i in range(30)]
        result = resolve_artist_match(netease, qq, "张方钊", "河南说唱之神")
        self.assertEqual(result.matched_tracks, 9)
        self.assertEqual(result.track_overlap, 0.9)
        self.assertEqual(result.status, "matched")

    def test_low_overlap_does_not_auto_match_same_name(self):
        result = resolve_artist_match(
            ["AAA", "BBB", "CCC"],
            ["AAA", "XXX", "YYY"],
            "Artist",
            "Artist",
        )
        self.assertNotEqual(result.status, "matched")


if __name__ == "__main__":
    unittest.main()
