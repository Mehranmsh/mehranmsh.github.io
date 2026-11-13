"""Tests for D. Smolken double-bass pizzicato SFZ parsing."""
from __future__ import annotations

import unittest
from unittest import mock

from fetch_dsmolken_double_bass import _request, parse_double_bass_pizz_sfz


def fixture() -> str:
    return """
<group>
hivel=74
<region>
sample=pizz\\pizz_c1_pa.wav
lokey=12
hikey=24
seq_length=3
pitch_keycenter=24
<region>
sample=pizz\\pizz_c1_pb.wav
lokey=12
hikey=24
seq_length=3
seq_position=2
pitch_keycenter=24
<region>
sample=pizz\\pizz_c1_pc.wav
lokey=12
hikey=24
seq_length=3
seq_position=3
pitch_keycenter=24
<group>
lovel=75
hivel=120
<region>
sample=pizz\\pizz_c1_ma.wav
lokey=12
hikey=24
seq_length=3
pitch_keycenter=24
<region>
sample=pizz\\pizz_c1_mb.wav
lokey=12
hikey=24
seq_length=3
seq_position=2
pitch_keycenter=24
<region>
sample=pizz\\pizz_c1_mc.wav
lokey=12
hikey=24
seq_length=3
seq_position=3
pitch_keycenter=24
<group>
lovel=121
hivel=127
<region>
sample=pizz\\pizz_c1_fa.wav
lokey=12
hikey=24
seq_length=3
pitch_keycenter=24
<region>
sample=pizz\\pizz_c1_fb.wav
lokey=12
hikey=24
seq_length=3
seq_position=2
pitch_keycenter=24
<region>
sample=pizz\\pizz_c1_fc.wav
lokey=12
hikey=24
seq_length=3
seq_position=3
pitch_keycenter=24
"""


class DoubleBassPizzTests(unittest.TestCase):
    def test_github_api_request_uses_scoped_token_when_available(self):
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self):
                return b"ok"

        with mock.patch.dict("os.environ", {"GITHUB_TOKEN": "test-token"}, clear=True), \\
             mock.patch("urllib.request.urlopen", return_value=Response()) as urlopen:
            self.assertEqual(_request("https://api.github.com/test"), b"ok")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")
        self.assertEqual(request.get_header("Accept"), "application/vnd.github+json")

    def test_group_velocity_zones_and_round_robin_are_inherited(self):
        samples = parse_double_bass_pizz_sfz(fixture(), require_complete=False)
        self.assertEqual(len(samples), 9)
        self.assertEqual({(x["velocity_min"], x["velocity_max"]) for x in samples},
                         {(1, 74), (75, 120), (121, 127)})
        self.assertEqual({x["round_robin_index"] for x in samples}, {0, 1, 2})

    def test_unpitched_noise_regions_are_excluded(self):
        sfz = fixture() + """
<region>
sample=pizz\\noises\\pizz_noise_slap_1.wav
lokey=81
hikey=81
pitch_keycenter=81
"""
        samples = parse_double_bass_pizz_sfz(sfz, require_complete=False)
        self.assertEqual(len(samples), 9)

    def test_invalid_velocity_range_is_rejected(self):
        sfz = fixture().replace("hivel=74", "hivel=0", 1)
        with self.assertRaisesRegex(ValueError, "velocity layer"):
            parse_double_bass_pizz_sfz(sfz, require_complete=False)

    def test_wrong_round_robin_sequence_is_rejected(self):
        sfz = fixture().replace("seq_position=3", "seq_position=4", 1)
        with self.assertRaisesRegex(ValueError, "round-robin"):
            parse_double_bass_pizz_sfz(sfz, require_complete=False)


if __name__ == "__main__":
    unittest.main()
