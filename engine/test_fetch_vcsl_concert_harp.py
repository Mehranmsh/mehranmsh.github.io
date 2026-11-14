"""Tests for the pinned VCSL Concert Harp import mapping."""
import unittest

from sfz_region_parser import parse_sfz_regions


class VcslConcertHarpTests(unittest.TestCase):
    def test_preserves_velocity_crossfade_offsets_tuning_and_volume(self):
        regions = parse_sfz_regions("""
<group>
ampeg_release=30
<region>
sample=Concert Harp/low_mf.wav
pitch_keycenter=40
lokey=40
hikey=42
xfout_lovel=70
xfout_hivel=100
offset=453
tune=22
volume=11.2
<region>
sample=Concert Harp/low_f.wav
pitch_keycenter=40
lokey=40
hikey=42
xfin_lovel=70
xfin_hivel=100
offset=148
tune=-3
volume=13.8
""")
        self.assertEqual(len(regions), 2)
        self.assertEqual(regions[0]["crossfade"], {"direction": "out", "velocity_range": [70, 100]})
        self.assertEqual(regions[1]["crossfade"], {"direction": "in", "velocity_range": [70, 100]})
        self.assertEqual(regions[0]["offset_sample_points"], 453)
        self.assertEqual(regions[1]["tune_cents"], -3.0)
        self.assertAlmostEqual(regions[1]["volume_db"], 13.8)

    def test_preserves_d4_hard_velocity_split(self):
        regions = parse_sfz_regions("""
<region>
hivel=100
sample=Concert Harp/D4_mf.wav
pitch_keycenter=62
lokey=61
hikey=63
<region>
lovel=101
sample=Concert Harp/D4_f.wav
pitch_keycenter=62
lokey=62
hikey=62
""")
        self.assertEqual([item["velocity_range"] for item in regions], [[0, 100], [101, 127]])
        self.assertTrue(all(item["crossfade"] is None for item in regions))


if __name__ == "__main__":
    unittest.main()
