import unittest

from fill_planner import plan_melody_fill


class MelodyFillPlannerTests(unittest.TestCase):
    def test_fill_is_contained_in_vocal_rest_and_prefers_chord_tones(self):
        result = plan_melody_fill(
            gap_start_tick=1920, gap_duration_ticks=480,
            scale_pitch_classes=[0, 2, 4, 5, 7, 9, 11],
            chord_pitch_classes=[0, 4, 7], reference_note=64,
        )
        events = result["events"]
        self.assertTrue(events)
        self.assertEqual(events[0]["start_tick"], 1920)
        self.assertLessEqual(events[-1]["start_tick"] + events[-1]["duration_ticks"], 2400)
        self.assertTrue(any(event["midi_note"] % 12 in {0, 4, 7} for event in events))
        self.assertFalse(result["audio_rendered"])

    def test_short_gap_produces_no_fill(self):
        result = plan_melody_fill(
            gap_start_tick=0, gap_duration_ticks=119,
            scale_pitch_classes=[0, 2, 4, 5, 7, 9, 11],
            chord_pitch_classes=[0, 4, 7], reference_note=60,
        )
        self.assertEqual(result["events"], [])
        self.assertEqual(result["reason"], "gap_too_short")

    def test_fill_is_deterministic(self):
        kwargs = dict(
            gap_start_tick=900, gap_duration_ticks=360,
            scale_pitch_classes=[0, 2, 3, 5, 7, 8, 10],
            chord_pitch_classes=[9, 0, 4], reference_note=69,
        )
        self.assertEqual(plan_melody_fill(**kwargs), plan_melody_fill(**kwargs))

    def test_fill_velocity_uses_bounded_contour_from_section_level(self):
        result = plan_melody_fill(
            gap_start_tick=0, gap_duration_ticks=720,
            scale_pitch_classes=[0, 2, 4, 5, 7, 9, 11],
            chord_pitch_classes=[0, 4, 7], reference_note=60,
            base_velocity=76,
        )
        velocities = [event["velocity"] for event in result["events"]]
        self.assertEqual(velocities[0], 76)
        self.assertEqual(velocities[1], 72)
        self.assertTrue(all(1 <= value <= 127 for value in velocities))

    def test_invalid_fill_velocity_is_rejected(self):
        with self.assertRaises(ValueError):
            plan_melody_fill(
                gap_start_tick=0, gap_duration_ticks=240,
                scale_pitch_classes=[0, 2, 4, 5, 7, 9, 11],
                chord_pitch_classes=[0, 4, 7], reference_note=60,
                base_velocity=128,
            )

    def test_invalid_pitch_classes_are_rejected(self):
        with self.assertRaises(ValueError):
            plan_melody_fill(
                gap_start_tick=0, gap_duration_ticks=240,
                scale_pitch_classes=[0, 12], chord_pitch_classes=[0, 4, 7],
                reference_note=60,
            )


if __name__ == "__main__":
    unittest.main()
