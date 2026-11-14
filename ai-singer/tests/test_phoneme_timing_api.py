import unittest

from fastapi import HTTPException

from server import plan_phoneme_timing


class PhonemeTimingApiTests(unittest.TestCase):
    def test_api_returns_timing_plan(self):
        result = plan_phoneme_timing({"syllables": [{
            "text": "سا", "start_seconds": 0, "end_seconds": 1,
            "phonemes": ["s", "ɒː"], "duration_weights": [1, 3],
        }]})
        self.assertEqual(result["schema"], "mehran.phoneme-timing-plan.v1")
        self.assertEqual(result["phoneme_count"], 2)
        self.assertFalse(result["audio_generated"])

    def test_api_rejects_invalid_timing(self):
        with self.assertRaises(HTTPException) as error:
            plan_phoneme_timing({"syllables": [{
                "start_seconds": 1, "end_seconds": 1,
                "phonemes": ["s"], "duration_weights": [1],
            }]})
        self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
