#!/usr/bin/env python3

import unittest

from album_resolver import compare_albums, normalise_album_title
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


class AlbumResolverTests(unittest.TestCase):
    def test_explicit_marker_is_ignored(self):
        self.assertEqual(
            normalise_album_title("某某专辑 (Explicit)"),
            normalise_album_title("某某专辑"),
        )

    def test_deluxe_marker_is_preserved(self):
        self.assertNotEqual(
            normalise_album_title("某某专辑 Deluxe"),
            normalise_album_title("某某专辑"),
        )

    def test_same_artist_explicit_album_is_ignored_as_duplicate(self):
        candidate = {
            "title": "某某专辑 (Explicit)",
            "barscopeArtistIds": ["bs_artist_123"],
            "releaseDate": "2025-05-20",
        }
        existing = {
            "title": "某某专辑",
            "barscopeArtistIds": ["bs_artist_123"],
            "releaseDate": "2025-05-20",
            "sourceId": "netease-1",
        }
        result = compare_albums(candidate, existing)
        self.assertEqual(result.status, "matched_ignore")


if __name__ == "__main__":
    unittest.main()
