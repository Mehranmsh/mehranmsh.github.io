import unittest

from fetch_meta_piano_bank import parse_sfz_sample_map, parse_sha256sums


class MetaPianoMapTests(unittest.TestCase):
    def test_sfz_parser_preserves_key_and_overlapping_velocity_groups(self):
        sfz = """
<group> lovel=1 hivel=39 xfout_lovel=24 xfout_hivel=39
<region> key=60 sample=INSPiano_Vel01_C4_01.ogg
<group> lovel=24 hivel=71 xfin_lovel=24 xfin_hivel=39
<region> key=60 sample=INSPiano_Vel02_C4_01.ogg
<group> lovel=56 hivel=103 xfin_lovel=56 xfin_hivel=71
<region> key=60 sample=INSPiano_Vel03_C4_01.ogg
<group> lovel=88 hivel=127 xfin_lovel=88 xfin_hivel=103
<region> key=60 sample=INSPiano_Vel04_C4_01.ogg
"""
        mapped = parse_sfz_sample_map(sfz)
        self.assertEqual(len(mapped), 4)
        self.assertEqual(mapped["INSPiano_Vel01_C4_01.ogg"], {
            "midi_note": 60, "velocity_min": 1, "velocity_max": 39,
        })
        self.assertEqual(mapped["INSPiano_Vel03_C4_01.ogg"], {
            "midi_note": 60, "velocity_min": 56, "velocity_max": 103,
        })
        self.assertEqual(mapped["INSPiano_Vel04_C4_01.ogg"]["velocity_min"], 88)

    def test_sfz_parser_rejects_regions_before_groups_and_duplicate_files(self):
        with self.assertRaisesRegex(ValueError, "before a velocity group"):
            parse_sfz_sample_map("<region> key=60 sample=INSPiano_Vel01_C4_01.ogg")
        duplicate = (
            "<group> lovel=1 hivel=39\n"
            "<region> key=60 sample=INSPiano_Vel01_C4_01.ogg\n"
            "<region> key=60 sample=INSPiano_Vel01_C4_01.ogg"
        )
        with self.assertRaisesRegex(ValueError, "Duplicate SFZ sample mapping"):
            parse_sfz_sample_map(duplicate)

    def test_checksum_parser_reads_sha256sum_format(self):
        digest = "a" * 64
        self.assertEqual(parse_sha256sums(f"{digest}  ogg/INSPiano_Vel01_C4_01.ogg"), {
            "ogg/INSPiano_Vel01_C4_01.ogg": digest,
        })

    def test_checksum_parser_rejects_empty_or_malformed_input(self):
        with self.assertRaisesRegex(ValueError, "no valid entries"):
            parse_sha256sums("not a checksum")


if __name__ == "__main__":
    unittest.main()
