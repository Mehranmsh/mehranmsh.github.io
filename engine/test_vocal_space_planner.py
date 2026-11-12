import unittest

from vocal_space_planner import plan_vocal_space


class VocalSpacePlannerTests(unittest.TestCase):
    def test_harmonic_support_is_reduced_during_lead_activity(self):
        result = plan_vocal_space("chords", 0, 480, [(0, 240)])
        self.assertLess(result["gain"], 1.0)
        self.assertEqual(result["mode"], "support_under_vocal")
        self.assertEqual(result["overlap_ratio"], 0.5)

    def test_accompaniment_recovers_in_vocal_rest(self):
        result = plan_vocal_space("guitar", 480, 240, [(0, 240)])
        self.assertEqual(result["gain"], 1.0)
        self.assertEqual(result["mode"], "vocal_rest")

    def test_rhythm_and_lead_are_not_ducked(self):
        for part in ("melody", "bass", "kick", "snare"):
            result = plan_vocal_space(part, 0, 480, [(0, 480)])
            self.assertEqual(result["gain"], 1.0)
            self.assertEqual(result["mode"], "unaffected")

    def test_ducking_is_bounded_for_full_overlap(self):
        result = plan_vocal_space("strings", 0, 480, [(0, 480)])
        self.assertEqual(result["gain"], 0.76)
        self.assertGreaterEqual(result["gain"], 0.68)

    def test_invalid_intervals_and_ticks_are_rejected(self):
        with self.assertRaises(ValueError):
            plan_vocal_space("chords", True, 120, [])
        with self.assertRaises(ValueError):
            plan_vocal_space("chords", 0, 0, [])
        with self.assertRaises(ValueError):
            plan_vocal_space("chords", 0, 120, [(30, 10)])


if __name__ == "__main__":
    unittest.main()
