import unittest

from fetch_meta_guitar_banks import parse_guitar_sfz_sample_map, parse_sha256sums


class MetaGuitarMapTests(unittest.TestCase):
    def test_steel_map_preserves_string_note_and_three_velocity_zones(self):
        sfz = """
<master> lochan=1 hichan=1
<group> group=1 off_by=1 lovel=1 hivel=48
<region> key=40 sample=INSGuitarSteel_StringLowE_Vel01_E2_01.ogg
<group> group=1 off_by=1 lovel=49 hivel=96
<region> key=40 sample=INSGuitarSteel_StringLowE_Vel02_E2_01.ogg
<group> group=1 off_by=1 lovel=97 hivel=127
<region> key=40 sample=INSGuitarSteel_StringLowE_Vel03_E2_01.ogg
<master> lochan=2 hichan=2
<group> group=1 off_by=1 lovel=1 hivel=48
<region> key=40 sample=INSGuitarSteel_StringLowE_Vel01_E2_01.ogg
"""
        mapped = parse_guitar_sfz_sample_map(sfz, "meta-steel-guitar")
        self.assertEqual(len(mapped), 3)
        first = mapped["INSGuitarSteel_StringLowE_Vel01_E2_01.ogg"]
        self.assertEqual(first["midi_note"], 40)
        self.assertEqual(first["string"], "LowE")
        self.assertEqual((first["velocity_min"], first["velocity_max"]), (1, 48))

    def test_nylon_map_uses_default_auto_keyswitch_and_preserves_articulation(self):
        sfz = """
<group> sw_last=24 group=1 lovel=1 hivel=50
<region> key=40 sample=INSGuitarNylon_StringLowE_Vel01Finger_E2_01.ogg
<group> sw_last=24 group=1 lovel=35 hivel=93
<region> key=40 sample=INSGuitarNylon_StringLowE_Vel02Pick_E2_01.ogg
<group> sw_last=24 group=1 lovel=78 hivel=127
<region> key=40 sample=INSGuitarNylon_StringLowE_Vel03Pick_E2_01.ogg
<group> sw_last=25 group=1
<region> key=40 sample=INSGuitarNylon_StringLowE_Vel01Finger_E2_01.ogg
"""
        mapped = parse_guitar_sfz_sample_map(sfz, "meta-nylon-guitar")
        self.assertEqual(len(mapped), 3)
        finger = mapped["INSGuitarNylon_StringLowE_Vel01Finger_E2_01.ogg"]
        pick = mapped["INSGuitarNylon_StringLowE_Vel02Pick_E2_01.ogg"]
        self.assertEqual(finger["articulation"], "finger")
        self.assertEqual(pick["articulation"], "pick")
        self.assertEqual((finger["velocity_min"], finger["velocity_max"]), (1, 127))
        self.assertEqual((pick["velocity_min"], pick["velocity_max"]), (1, 71))
        firm_pick = mapped["INSGuitarNylon_StringLowE_Vel03Pick_E2_01.ogg"]
        self.assertEqual((firm_pick["velocity_min"], firm_pick["velocity_max"]), (56, 127))

    def test_parser_rejects_filename_key_mismatch_and_duplicate_regions(self):
        mismatch = """
<master> lochan=1 hichan=1
<group> group=1 lovel=1 hivel=48
<region> key=41 sample=INSGuitarSteel_StringLowE_Vel01_E2_01.ogg
"""
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            parse_guitar_sfz_sample_map(mismatch, "meta-steel-guitar")
        duplicate = (
            "<master> lochan=1 hichan=1\n"
            "<group> group=1 lovel=1 hivel=48\n"
            "<region> key=40 sample=INSGuitarSteel_StringLowE_Vel01_E2_01.ogg\n"
            "<group> group=1 lovel=49 hivel=96\n"
            "<region> key=40 sample=INSGuitarSteel_StringLowE_Vel01_E2_01.ogg"
        )
        with self.assertRaisesRegex(ValueError, "Conflicting default"):
            parse_guitar_sfz_sample_map(duplicate, "meta-steel-guitar")

    def test_checksum_parser_reads_and_rejects_bad_input(self):
        digest = "b" * 64
        self.assertEqual(parse_sha256sums(f"{digest}  ogg/sample.ogg"), {"ogg/sample.ogg": digest})
        with self.assertRaisesRegex(ValueError, "no valid entries"):
            parse_sha256sums("bad checksum")


if __name__ == "__main__":
    unittest.main()
