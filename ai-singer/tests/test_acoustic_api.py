import unittest

from fastapi import HTTPException

from server import validate_model_conditioning


def payload():
    return {
        "schema_version": "mehran.svs.conditioning.v1",
        "project_id": "api-test-fa",
        "language": "fa",
        "sample_rate": 48000,
        "duration_seconds": 1.5,
        "phonemes": [
            {"phoneme": "æ", "start_seconds": 0.0, "end_seconds": 0.6},
            {"phoneme": "m", "start_seconds": 0.6, "end_seconds": 1.0},
        ],
        "notes": [
            {"midi_note": 60, "start_seconds": 0.0, "duration_seconds": 0.7},
            {"midi_note": 62, "start_seconds": 0.7, "duration_seconds": 0.7},
        ],
    }


class AcousticConditioningApiTests(unittest.TestCase):
    def test_endpoint_validates_contract_without_running_inference(self):
        result = validate_model_conditioning(payload())
        self.assertTrue(result["valid"])
        self.assertFalse(result["accepted_for_inference"])
        self.assertFalse(result["inference_ready"])
        self.assertFalse(result["audio_generated"])
        self.assertEqual(result["phoneme_count"], 2)
        self.assertEqual(result["note_count"], 2)

    def test_endpoint_rejects_invalid_contract(self):
        data = payload()
        data["phonemes"][1]["start_seconds"] = 0.2
        with self.assertRaises(HTTPException) as error:
            validate_model_conditioning(data)
        self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
