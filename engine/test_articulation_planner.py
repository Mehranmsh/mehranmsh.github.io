import unittest

from articulation_planner import choose_articulation, plan_articulations


class ArticulationPlannerTests(unittest.TestCase):
    def test_long_violin_note_prefers_long_bow(self):
        result = choose_articulation({"duration_ticks": 960}, "violin", 90)
        self.assertEqual(result["articulation"], "long_bow")
        self.assertEqual(result["status"], "planned")

    def test_short_piano_note_prefers_staccato(self):
        result = choose_articulation({"duration_ticks": 180}, "piano", 110)
        self.assertEqual(result["articulation"], "staccato")

    def test_repeated_guitar_note_prefers_muted_attack(self):
        result = choose_articulation(
            {"duration_ticks": 300, "midi_note": 60, "previous_note": 60},
            "acoustic_guitar", 100)
        self.assertEqual(result["articulation"], "palm_mute")

    def test_expressive_bowed_leap_can_use_tremolo(self):
        result = choose_articulation(
            {"duration_ticks": 480, "midi_note": 60, "next_note": 69},
            "violin", 100, "expressive")
        self.assertEqual(result["articulation"], "tremolo")

    def test_explicit_missing_articulation_is_blocked_not_substituted(self):
        result = choose_articulation(
            {"duration_ticks": 480, "explicit_articulation": "pizzicato"},
            "violin", 100, available_articulations=["long_bow", "short_bow"])
        self.assertEqual(result["articulation"], "pizzicato")
        self.assertEqual(result["status"], "blocked_missing_sample")

    def test_plan_derives_neighbor_notes_and_reports_counts(self):
        result = plan_articulations([
            {"midi_note": 60, "duration_ticks": 240},
            {"midi_note": 60, "duration_ticks": 960, "phrase_final": True},
        ], "piano", 90)
        self.assertEqual(result["event_count"], 2)
        self.assertEqual(result["articulation_counts"], {"staccato": 1, "sustain": 1})
        self.assertFalse(result["audio_rendered"])

    def test_rejects_invalid_inputs(self):
        with self.assertRaises(ValueError):
            choose_articulation({"duration_ticks": 0}, "piano", 90)
        with self.assertRaises(ValueError):
            choose_articulation({"duration_ticks": 480}, "unknown", 90)


if __name__ == "__main__":
    unittest.main()
