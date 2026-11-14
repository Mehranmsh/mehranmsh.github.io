import unittest

from phoneme_timing import PhonemeTimingError, build_phoneme_timing_plan


class PhonemeTimingTests(unittest.TestCase):
    def test_allocates_weighted_phoneme_intervals(self):
        result = build_phoneme_timing_plan([{
            "text": "سا",
            "start_seconds": 1.0,
            "end_seconds": 2.0,
            "phonemes": ["s", "ɒː"],
            "duration_weights": [1, 3],
        }])
        events = result["syllables"][0]["phonemes"]
        self.assertEqual(events[0]["start_seconds"], 1.0)
        self.assertEqual(events[0]["end_seconds"], 1.25)
        self.assertEqual(events[1]["end_seconds"], 2.0)
        self.assertTrue(result["requires_review"])
        self.assertFalse(result["acoustic_alignment_performed"])

    def test_rejects_overlap(self):
        rows = [
            {"start_seconds": 0, "end_seconds": 1, "phonemes": ["s"], "duration_weights": [1]},
            {"start_seconds": 0.9, "end_seconds": 2, "phonemes": ["æ"], "duration_weights": [1]},
        ]
        with self.assertRaisesRegex(PhonemeTimingError, "non-overlapping"):
            build_phoneme_timing_plan(rows)

    def test_rejects_weight_count_mismatch(self):
        with self.assertRaisesRegex(PhonemeTimingError, "one positive weight"):
            build_phoneme_timing_plan([{
                "start_seconds": 0, "end_seconds": 1,
                "phonemes": ["s", "æ"], "duration_weights": [1],
            }])

    def test_rejects_nonpositive_weights(self):
        with self.assertRaisesRegex(PhonemeTimingError, "positive"):
            build_phoneme_timing_plan([{
                "start_seconds": 0, "end_seconds": 1,
                "phonemes": ["s"], "duration_weights": [0],
            }])

    def test_rejects_unknown_phoneme(self):
        with self.assertRaisesRegex(ValueError, "unsupported"):
            build_phoneme_timing_plan([{
                "start_seconds": 0, "end_seconds": 1,
                "phonemes": ["v/uː/oː"], "duration_weights": [1],
            }])


if __name__ == "__main__":
    unittest.main()
