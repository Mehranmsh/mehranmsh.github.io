import unittest

from fastapi import HTTPException

from server import prepare_model_conditioning


class PrepareConditioningApiTests(unittest.TestCase):
    def payload(self):
        return {
            "project_id": "prepare-api-01",
            "duration_seconds": 1.0,
            "timing_plan": {
                "schema": "mehran.phoneme-timing-plan.v1",
                "requires_review": True,
                "syllables": [{
                    "phonemes": [
                        {"phoneme": "s", "start_seconds": 0.0, "end_seconds": 0.2},
                        {"phoneme": "æ", "start_seconds": 0.2, "end_seconds": 0.8},
                    ]
                }],
            },
            "notes": [
                {"midi_note": 60, "start_seconds": 0.0, "duration_seconds": 0.5},
                {"midi_note": 62, "start_seconds": 0.5, "duration_seconds": 0.5},
            ],
        }

    def test_endpoint_prepares_contract_without_inference(self):
        result = prepare_model_conditioning(self.payload())
        self.assertEqual(result["conditioning"]["project_id"], "prepare-api-01")
        self.assertEqual(result["phoneme_note_mapping"][1]["note_indices"], [0, 1])
        self.assertFalse(result["accepted_for_inference"])
        self.assertFalse(result["audio_generated"])

    def test_endpoint_rejects_missing_note_overlap(self):
        data = self.payload()
        data["notes"] = [{"midi_note": 60, "start_seconds": 0, "duration_seconds": 0.1}]
        with self.assertRaises(HTTPException) as error:
            prepare_model_conditioning(data)
        self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
