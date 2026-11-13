"""Unit tests for FreePats CC0 electric bass SFZ maps."""
from __future__ import annotations

import unittest

from fetch_freepats_electric_bass import parse_freepats_bass_sfz
from sample_renderer import _resolve_part_articulation


class FreePatsBassTests(unittest.TestCase):
    def test_parser_preserves_multi_attribute_range_and_root_pitch(self):
        sfz = """
<region>
lokey=26 hikey=28 pitch_keycenter=28
sample=samples/finger/E.flac
<region>
key=29
sample=samples/finger/F.flac
"""
        regions = parse_freepats_bass_sfz(sfz, "finger", require_complete=False)
        self.assertEqual(regions[0]["midi_note"], 28)
        self.assertEqual((regions[0]["playable_key_min"], regions[0]["playable_key_max"]), (26, 28))
        self.assertEqual(regions[1]["midi_note"], 29)

    def test_finger_and_pick_keep_distinct_articulations(self):
        finger = """
<region>
lokey=26 hikey=28 pitch_keycenter=28
sample=samples/finger/E.flac
"""
        pick = """
<region>
lokey=26 hikey=28 pitch_keycenter=28
sample=samples/pick/E.flac
"""
        self.assertEqual(
            parse_freepats_bass_sfz(finger, "finger", require_complete=False)[0]["articulation"],
            "fingerstyle",
        )
        self.assertEqual(
            parse_freepats_bass_sfz(pick, "pick", require_complete=False)[0]["articulation"],
            "pick",
        )

    def test_composition_bass_part_defaults_to_recorded_fingerstyle(self):
        articulation, source = _resolve_part_articulation(
            "bass", "sustain", "legacy_default"
        )
        self.assertEqual(articulation, "fingerstyle")
        self.assertEqual(source, "instrument_default")

    def test_parser_rejects_filename_pitch_mismatch(self):
        sfz = """
<region>
key=29
sample=samples/finger/E.flac
"""
        with self.assertRaisesRegex(ValueError, "pitch mismatch"):
            parse_freepats_bass_sfz(sfz, "finger", require_complete=False)

    def test_parser_rejects_playable_key_range_gaps(self):
        sfz = """
<region>
lokey=26 hikey=28 pitch_keycenter=28
sample=samples/finger/E.flac
<region>
key=30
sample=samples/finger/F#.flac
"""
        with self.assertRaisesRegex(ValueError, "coverage gap or overlap"):
            parse_freepats_bass_sfz(sfz, "finger", require_complete=False)

    def test_parser_rejects_wrong_articulation_directory(self):
        sfz = """
<region>
lokey=26 hikey=28 pitch_keycenter=28
sample=samples/pick/E.flac
"""
        with self.assertRaisesRegex(ValueError, "Unexpected FreePats"):
            parse_freepats_bass_sfz(sfz, "finger", require_complete=False)


if __name__ == "__main__":
    unittest.main()
