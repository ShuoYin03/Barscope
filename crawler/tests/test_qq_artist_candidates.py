#!/usr/bin/env python3

import unittest

from crawl_qq_artist_candidates import candidate_name_score


class QQArtistCandidateTests(unittest.TestCase):
    def test_exact_name_gets_full_score(self):
        self.assertEqual(candidate_name_score("TOYOKI", "toyoki"), 1.0)

    def test_embedded_alias_keeps_high_score(self):
        self.assertGreaterEqual(candidate_name_score("艾志恒Asen", "Asen 艾志恒"), 0.85)

    def test_unrelated_name_scores_low(self):
        self.assertLess(candidate_name_score("THOME", "王以太"), 0.5)


if __name__ == "__main__":
    unittest.main()
