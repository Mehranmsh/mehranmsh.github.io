"""Unit tests for the pinned Virtuosity SFZ parser."""
from __future__ import annotations

import unittest

from fetch_virtuosity_drums import parse_keymap_note, parse_virtuosity_sfz_map


KEYMAP = """
#define $KICK_SNRIGHT_KEY 36
#define $SNARE_CENTER_KEY 38
#define $HH_CLOSED_KEY 42
#define $HH_OPEN_KEY 42
"""


class VirtuositySFZTests(unittest.TestCase):
    def test_keymap_resolves_verified_gm_keys(self):
        self.assertEqual(parse_keymap_note(KEYMAP, "KICK_SNRIGHT_KEY"), 36)
        self.assertEqual(parse_keymap_note(KEYMAP, "SNARE_CENTER_KEY"), 38)
        self.assertEqual(parse_keymap_note(KEYMAP, "HH_CLOSED_KEY"), 42)
        self.assertEqual(parse_keymap_note(KEYMAP, "HH_OPEN_KEY"), 42)

    def test_kick_velocity_and_round_robin_are_preserved(self):
        sfz = """
<region>
sample=../Samples/kickmic/kick/kickmic_kick_snon_vl1_rr1.flac
hivel=31
seq_length=4

<region>
sample=../Samples/kickmic/kick/kickmic_kick_snon_vl1_rr2.flac
hivel=31
seq_length=4
seq_position=2

<region>
sample=../Samples/kickmic/kick/kickmic_kick_snon_vl2_rr1.flac
lovel=32
hivel=127
seq_length=1
"""
        regions = parse_virtuosity_sfz_map(sfz, "kick", keymap_text=KEYMAP)
        self.assertEqual(len(regions), 3)
        self.assertEqual(regions[0]["midi_note"], 36)
        self.assertEqual(regions[0]["round_robin_index"], 0)
        self.assertEqual(regions[1]["round_robin_index"], 1)
        self.assertEqual((regions[0]["velocity_min"], regions[0]["velocity_max"]), (1, 31))

    def test_snare_center_has_velocity_layers_without_fake_round_robin(self):
        sfz = """
<region>
sample=../Samples/kickmic/snare/kickmic_snare_center_vl1.flac
hivel=3

<region>
sample=../Samples/kickmic/snare/kickmic_snare_center_vl2.flac
lovel=4
hivel=127
"""
        regions = parse_virtuosity_sfz_map(sfz, "snare", keymap_text=KEYMAP)
        self.assertEqual([item["round_robin_index"] for item in regions], [0, 0])
        self.assertEqual(regions[0]["articulation"], "center")

    def test_parser_rejects_filename_round_robin_mismatch(self):
        sfz = """
<region>
sample=../Samples/kickmic/kick/kickmic_kick_snon_vl1_rr1.flac
hivel=31
seq_length=4
seq_position=2
"""
        with self.assertRaisesRegex(ValueError, "mismatch"):
            parse_virtuosity_sfz_map(sfz, "kick", keymap_text=KEYMAP)

    def test_parser_rejects_velocity_gaps(self):
        sfz = """
<region>
sample=../Samples/kickmic/kick/kickmic_kick_snon_vl1_rr1.flac
hivel=30
seq_length=1

<region>
sample=../Samples/kickmic/kick/kickmic_kick_snon_vl2_rr1.flac
lovel=32
seq_length=1
"""
        with self.assertRaisesRegex(ValueError, "coverage gap"):
            parse_virtuosity_sfz_map(sfz, "kick", keymap_text=KEYMAP)


if __name__ == "__main__":
    unittest.main()
