import unittest

from sfz_region_parser import parse_sfz_regions


SOURCE = """
<group>
ampeg_attack=0.004
<region>
sample=Concert_Harp/E1_f1.wav pitch_keycenter=28 lokey=28 hikey=29 offset=453 tune=22 volume=11.2
<region>
xfout_lovel=70 xfout_hivel=100
sample=Concert_Harp/G1_mp1.wav pitch_keycenter=31 lokey=30 hikey=33 tune=22 volume=33.7
<region>
xfin_lovel=70 xfin_hivel=100
sample=Concert_Harp/G1_f1.wav pitch_keycenter=31 lokey=30 hikey=33 offset=148 tune=20 volume=13.8
<region>
hivel=100 sample=Concert_Harp/D4_mf1.wav pitch_keycenter=62 lokey=61 hikey=63
<region>
lovel=101 sample=Concert_Harp/D4_f1.wav pitch_keycenter=62 lokey=62 hikey=62
"""


class SfzRegionParserTests(unittest.TestCase):
    def test_preserves_key_zone_offset_tuning_and_gain(self):
        regions = parse_sfz_regions(SOURCE)
        self.assertEqual(len(regions), 5)
        first = regions[0]
        self.assertEqual(first["key_range"], [28, 29])
        self.assertEqual(first["pitch_keycenter"], 28)
        self.assertEqual(first["offset_sample_points"], 453)
        self.assertEqual(first["tune_cents"], 22.0)
        self.assertAlmostEqual(first["volume_db"], 11.2)

    def test_preserves_crossfade_direction_and_range_without_flattening(self):
        regions = parse_sfz_regions(SOURCE)
        self.assertEqual(regions[1]["crossfade"], {
            "direction": "out", "velocity_range": [70, 100]
        })
        self.assertEqual(regions[2]["crossfade"], {
            "direction": "in", "velocity_range": [70, 100]
        })
        self.assertEqual(regions[1]["velocity_range"], [0, 127])

    def test_preserves_hard_velocity_split(self):
        regions = parse_sfz_regions(SOURCE)
        self.assertEqual(regions[3]["velocity_range"], [0, 100])
        self.assertEqual(regions[4]["velocity_range"], [101, 127])
        self.assertIsNone(regions[3]["crossfade"])
        self.assertIsNone(regions[4]["crossfade"])

    def test_sample_paths_may_contain_spaces(self):
        regions = parse_sfz_regions(
            "<region>\\nsample=Concert Harp/E1 f1.wav pitch_keycenter=28 lokey=28 hikey=29"
        )
        self.assertEqual(regions[0]["sample"], "Concert Harp/E1 f1.wav")

    def test_rejects_unsupported_playback_opcode(self):
        with self.assertRaisesRegex(ValueError, "Unsupported SFZ region opcode"):
            parse_sfz_regions("<region>\nsample=a.wav pitch_keycenter=60 lokey=60 hikey=60 cutoff=12000")

    def test_rejects_path_traversal(self):
        with self.assertRaisesRegex(ValueError, "escapes the bank"):
            parse_sfz_regions("<region>\nsample=../escape.wav pitch_keycenter=60 lokey=60 hikey=60")

    def test_rejects_incomplete_crossfade(self):
        with self.assertRaisesRegex(ValueError, "requires both"):
            parse_sfz_regions("<region>\nsample=a.wav pitch_keycenter=60 lokey=60 hikey=60 xfout_lovel=70")


if __name__ == "__main__":
    unittest.main()
