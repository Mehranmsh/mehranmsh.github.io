"""Tests for the VCSL cajón one-shot region map."""
from __future__ import annotations

import unittest

from fetch_vcsl_cajon import parse_cajon_regions


class VCSLCajonTests(unittest.TestCase):
    def test_all_strokes_and_velocity_zones_are_present(self):
        regions = parse_cajon_regions()
        self.assertEqual(len(regions), 17)
        self.assertEqual({x["articulation"] for x in regions}, {"bass", "slap", "tone"})
        self.assertEqual({x["midi_note"] for x in regions}, {60, 61, 62})
        self.assertTrue(all(x["one_shot"] for x in regions))
        self.assertEqual({(x["velocity_min"], x["velocity_max"]) for x in regions},
                         {(1, 65), (66, 99), (100, 127)})

    def test_bass_and_slap_have_two_takes_in_each_zone(self):
        regions = parse_cajon_regions()
        for articulation in ("bass", "slap"):
            for zone in ((1, 65), (66, 99), (100, 127)):
                takes = sorted(x["round_robin_index"] for x in regions
                               if x["articulation"] == articulation
                               and (x["velocity_min"], x["velocity_max"]) == zone)
                self.assertEqual(takes, [0, 1])

    def test_high_tone_stroke_has_one_source_take(self):
        regions = parse_cajon_regions()
        takes = [x["round_robin_index"] for x in regions
                 if x["articulation"] == "tone"
                 and (x["velocity_min"], x["velocity_max"]) == (100, 127)]
        self.assertEqual(takes, [0])


if __name__ == "__main__":
    unittest.main()
