import unittest

from expression_planner import plan_part_expression


class PartExpressionTests(unittest.TestCase):
    def test_melody_and_rhythm_anchors_stay_centered(self):
        for part in ("melody", "bass", "kick", "snare"):
            self.assertEqual(plan_part_expression(part, "chorus", 0.5)["pan"], 0.0)

    def test_chord_width_expands_in_chorus_and_narrows_in_bridge(self):
        verse = plan_part_expression("chords", "verse", 0.3)
        chorus = plan_part_expression("chords", "chorus", 0.3)
        bridge = plan_part_expression("chords", "bridge", 0.3)
        self.assertGreater(chorus["stereo_width"], verse["stereo_width"])
        self.assertLess(bridge["stereo_width"], verse["stereo_width"])
        self.assertEqual(chorus["pan"], verse["pan"])

    def test_hat_pattern_alternates_stereo_position(self):
        left = plan_part_expression("closed_hat", "verse", event_index=0)
        right = plan_part_expression("closed_hat", "verse", event_index=1)
        self.assertEqual(left["pan"], -0.14)
        self.assertEqual(right["pan"], 0.14)

    def test_optional_layers_keep_bounded_section_aware_positions(self):
        guitar = plan_part_expression("guitar", "final_chorus", -0.5)
        strings = plan_part_expression("strings", "chorus", 0.6)
        self.assertLess(guitar["pan"], -0.5)
        self.assertGreater(strings["pan"], 0.6)
        self.assertTrue(-1.0 <= guitar["pan"] <= 1.0)
        self.assertTrue(-1.0 <= strings["pan"] <= 1.0)

    def test_harp_and_cello_have_separate_stereo_positions(self):
        harp = plan_part_expression("harp", "chorus", 0.4)
        cello = plan_part_expression("cello", "chorus", -0.4)
        self.assertGreater(harp["pan"], 0.4)
        self.assertLess(cello["pan"], -0.4)

    def test_nylon_guitar_has_a_separate_stereo_profile(self):
        nylon = plan_part_expression("nylon_guitar", "verse")
        steel = plan_part_expression("guitar", "verse")
        self.assertNotEqual(nylon["profile"], steel["profile"])
        self.assertNotEqual(nylon["pan"], steel["pan"])

    def test_recorder_and_dan_tranh_have_distinct_stereo_profiles(self):
        recorder = plan_part_expression("recorder", "chorus", 0.12)
        dan_tranh = plan_part_expression("dan_tranh", "chorus", 0.22)
        self.assertNotEqual(recorder["profile"], dan_tranh["profile"])
        self.assertNotEqual(recorder["pan"], dan_tranh["pan"])

    def test_flute_uses_a_separate_stereo_position(self):
        flute = plan_part_expression("flute", "chorus", -0.18)
        self.assertLess(flute["pan"], 0)
        self.assertIn("flute", flute["profile"])

    def test_invalid_inputs_are_rejected(self):
        with self.assertRaises(ValueError):
            plan_part_expression("unknown", "verse")
        with self.assertRaises(ValueError):
            plan_part_expression("melody", "intro")
        with self.assertRaises(ValueError):
            plan_part_expression("melody", "verse", 1.1)


if __name__ == "__main__":
    unittest.main()
