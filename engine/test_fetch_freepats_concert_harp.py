"""Tests for the pinned FreePats Concert Harp SFZ import."""
import unittest

from fetch_freepats_concert_harp import _coverage
from sfz_region_parser import parse_sfz_regions


class ConcertHarpImportTests(unittest.TestCase):
    def test_parses_hard_split_velocity_layers_and_tuning(self):
        regions = parse_sfz_regions("""
<group>
ampeg_release=5
<region>
sample=samples/low.wav
pitch_keycenter=40
lokey=40 hikey=42
hivel=90
tune=12
<region>
sample=samples/low_f.wav
pitch_keycenter=40
lokey=40 hikey=42
lovel=91
tune=-3
""")
        self.assertEqual(len(regions), 2)
        self.assertEqual(regions[0]["velocity_range"], [0, 90])
        self.assertEqual(regions[1]["velocity_range"], [91, 127])
        self.assertEqual(regions[0]["tune_cents"], 12.0)
        self.assertEqual(regions[1]["tune_cents"], -3.0)

    def test_rejects_velocity_holes(self):
        regions = parse_sfz_regions("""
<region>
sample=samples/low.wav
pitch_keycenter=40
lokey=40 hikey=40
hivel=80
""")
        with self.assertRaisesRegex(ValueError, "coverage"):
            _coverage(regions)

    def test_accepts_complete_key_and_velocity_coverage(self):
        regions = parse_sfz_regions("""
<region>
sample=samples/low.wav
pitch_keycenter=40
lokey=40 hikey=41
hivel=90
<region>
sample=samples/low_f.wav
pitch_keycenter=40
lokey=40 hikey=41
lovel=91
""")
        result = _coverage(regions)
        self.assertEqual(result, {"midi_min": 40, "midi_max": 41, "mapped_keys": 2})


if __name__ == "__main__":
    unittest.main()
