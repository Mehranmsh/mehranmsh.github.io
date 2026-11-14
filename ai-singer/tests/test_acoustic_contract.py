from __future__ import annotations

import unittest
from pydantic import ValidationError

from acoustic_contract import validate_acoustic_conditioning


def valid_payload() -> dict:
    return {
        "schema_version": "mehran.svs.conditioning.v1",
        "project_id": "project-fa-001",
        "language": "fa",
        "sample_rate": 48000,
        "duration_seconds": 2.0,
        "speaker_profile_id": "speaker-consented-01",
        "phonemes": [
            {"phoneme": "s", "start_seconds": 0.0, "end_seconds": 0.12},
            {"phoneme": "a", "start_seconds": 0.12, "end_seconds": 0.7},
            {"phoneme": "l", "start_seconds": 0.7, "end_seconds": 0.9},
        ],
        "notes": [
            {"midi_note": 60, "start_seconds": 0.0, "duration_seconds": 0.7, "velocity": 85},
            {"midi_note": 62, "start_seconds": 0.7, "duration_seconds": 0.8, "velocity": 80},
        ],
        "style": {
            "pitch_shift_semitones": 0,
            "energy": 0.7,
            "breathiness": 0.15,
            "vibrato_depth": 0.2,
            "vibrato_rate_hz": 5.2,
        },
    }


class AcousticConditioningContractTests(unittest.TestCase):
    def assert_invalid(self, payload, message=None):
        with self.assertRaises(ValidationError) as error:
            validate_acoustic_conditioning(payload)
        if message:
            self.assertIn(message, str(error.exception))

    def test_valid_persian_conditioning_contract(self):
        result = validate_acoustic_conditioning(valid_payload())
        self.assertEqual(result.language, "fa")
        self.assertEqual(len(result.phonemes), 3)
        self.assertEqual(len(result.notes), 2)

    def test_rejects_unknown_schema(self):
        payload = valid_payload()
        payload["schema_version"] = "other"
        self.assert_invalid(payload)

    def test_rejects_unsupported_language(self):
        payload = valid_payload()
        payload["language"] = "xx"
        self.assert_invalid(payload)

    def test_rejects_unsupported_sample_rate(self):
        payload = valid_payload()
        payload["sample_rate"] = 32000
        self.assert_invalid(payload)

    def test_rejects_overlapping_phonemes(self):
        payload = valid_payload()
        payload["phonemes"][1]["start_seconds"] = 0.1
        self.assert_invalid(payload, "non-overlapping")

    def test_rejects_out_of_order_notes(self):
        payload = valid_payload()
        payload["notes"][0]["start_seconds"] = 0.7\n        payload["notes"][1]["start_seconds"] = 0.0
        self.assert_invalid(payload, "ordered")

    def test_rejects_timeline_overrun(self):
        payload = valid_payload()
        payload["notes"][1]["duration_seconds"] = 2
        self.assert_invalid(payload, "exceeds")

    def test_rejects_pitch_outside_midi_range(self):
        payload = valid_payload()
        payload["notes"][0]["midi_note"] = 128
        self.assert_invalid(payload)

    def test_rejects_unknown_fields(self):
        payload = valid_payload()
        payload["raw_checkpoint_path"] = "/tmp/model.pt"
        self.assert_invalid(payload)

    def test_rejects_invalid_vocal_style(self):
        payload = valid_payload()
        payload["style"]["breathiness"] = 1.5
        self.assert_invalid(payload)


if __name__ == "__main__":
    unittest.main()
