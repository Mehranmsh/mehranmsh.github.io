import io
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from fetch_meta_guitar_banks import _download, parse_guitar_sfz_sample_map, parse_sha256sums


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
<region> key=45 sample=INSGuitarSteel_StringA_Vel01_A2_01.ogg
"""
        mapped = parse_guitar_sfz_sample_map(sfz, "meta-steel-guitar")
        self.assertEqual(len(mapped), 4)
        first = mapped["INSGuitarSteel_StringLowE_Vel01_E2_01.ogg"]
        self.assertEqual(first["midi_note"], 40)
        self.assertEqual(first["string"], "LowE")
        self.assertEqual((first["velocity_min"], first["velocity_max"]), (1, 48))
        self.assertEqual(mapped["INSGuitarSteel_StringA_Vel01_A2_01.ogg"]["string"], "A")

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

    def test_steel_map_supports_single_key_range_and_pitch_keycenter(self):
        sfz = """
<master> lochan=1 hichan=1
<group> group=1 lovel=1 hivel=48
<region> key=46 sample=INSGuitarSteel_StringLowE_Vel01_As2_01.ogg
<region> lokey=47 hikey=47 pitch_keycenter=46 sample=INSGuitarSteel_StringLowE_Vel01_As2_01.ogg
"""
        mapped = parse_guitar_sfz_sample_map(sfz, "meta-steel-guitar")
        self.assertEqual(len(mapped), 2)
        base = mapped["INSGuitarSteel_StringLowE_Vel01_As2_01.ogg"]
        adjacent = mapped["INSGuitarSteel_StringLowE_Vel01_As2_01.ogg#key47"]
        self.assertEqual(base["midi_note"], 46)
        self.assertEqual(adjacent["midi_note"], 47)
        self.assertEqual(adjacent["source_midi_note"], 46)

    def test_checksum_parser_reads_and_rejects_bad_input(self):
        digest = "b" * 64
        self.assertEqual(parse_sha256sums(f"{digest}  ogg/sample.ogg"), {"ogg/sample.ogg": digest})
        with self.assertRaisesRegex(ValueError, "no valid entries"):
            parse_sha256sums("bad checksum")


    def test_download_retries_transient_network_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "sample.ogg"
            with patch("fetch_meta_guitar_banks.urllib.request.urlopen",
                       side_effect=[urllib.error.URLError("temporary"), io.BytesIO(b"verified-source")]) as fetch, \
                 patch("fetch_meta_guitar_banks.time.sleep") as sleep:
                _download("https://example.invalid/sample.ogg", destination)
            self.assertEqual(destination.read_bytes(), b"verified-source")
            self.assertEqual(fetch.call_count, 2)
            sleep.assert_called_once_with(1)

    def test_download_does_not_retry_permanent_http_error(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "sample.ogg"
            error = urllib.error.HTTPError("https://example.invalid/missing", 404, "Not Found", {}, None)
            with patch("fetch_meta_guitar_banks.urllib.request.urlopen", side_effect=error) as fetch, \
                 patch("fetch_meta_guitar_banks.time.sleep") as sleep:
                with self.assertRaises(urllib.error.HTTPError):
                    _download("https://example.invalid/missing", destination)
            fetch.assert_called_once()
            sleep.assert_not_called()
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
