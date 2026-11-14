"""Tests for VCSL Kalimba, Kenya SFZ mapping."""
from __future__ import annotations

import unittest
from unittest import mock

from fetch_vcsl_kalimba import _request, parse_kalimba_websfz


def region(sample: str, note: int, *, rr: int = 1, seq: int = 1,
           seq_length: int = 1, tune: float = 0, volume: float = 0) -> dict:
    return {
        "sample": "Kalimba, Kenya/" + sample,
        "pitch_keycenter": note, "lokey": note, "hikey": note,
        "seq_position": seq, "seq_length": seq_length,
        "tune": tune, "volume": volume,
    }


def fixture() -> dict:
    return {
        "meta": {
            "name": "Kalimba, Kenya", "license": "Creative Commons 0",
            "source": "https://github.com/sgossner/VCSL",
        },
        "groups": [{
            "regions": [
                region("test_D#3_k6_vl3_rr2", 63, rr=0, seq=1, seq_length=2, tune=7, volume=3),
                region("test_D#3_k9_vl3_rr2", 63, rr=0, seq=2, seq_length=2, tune=5, volume=-2),
            ]
        }],
    }


class VCSLKalimbaTests(unittest.TestCase):
    def test_github_api_request_uses_scoped_token_when_available(self):
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self):
                return b"ok"

        with mock.patch.dict("os.environ", {"GITHUB_TOKEN": "test-token"}, clear=True), \
             mock.patch("urllib.request.urlopen", return_value=Response()) as urlopen:
            self.assertEqual(_request("https://api.github.com/test"), b"ok")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")

    def test_preserves_pitch_round_robin_and_sample_tuning(self):
        regions = parse_kalimba_websfz(fixture(), require_complete=False)
        self.assertEqual(len(regions), 2)
        self.assertEqual([x["round_robin_index"] for x in regions], [0, 1])
        self.assertEqual([x["tuning_cents"] for x in regions], [7.0, 5.0])
        self.assertEqual([x["gain_db"] for x in regions], [3.0, -2.0])
        self.assertEqual(regions[0]["midi_note"], 63)

    def test_rejects_wrong_source_license(self):
        data = fixture()
        data["meta"]["license"] = "CC-BY"
        with self.assertRaisesRegex(ValueError, "CC0 VCSL"):
            parse_kalimba_websfz(data)

    def test_rejects_invalid_pitch_center(self):
        data = fixture()
        data["groups"][0]["regions"][0]["pitch_keycenter"] = 128
        with self.assertRaisesRegex(ValueError, "pitch mapping"):
            parse_kalimba_websfz(data)

    def test_rejects_incomplete_round_robin(self):
        data = fixture()
        data["groups"][0]["regions"].pop()
        with self.assertRaisesRegex(ValueError, "Expected 14 mapped"):
            parse_kalimba_websfz(data)


if __name__ == "__main__":
    unittest.main()
