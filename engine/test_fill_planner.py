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

    def test_instrument_profiles_have_distinct_phrasing_and_articulations(self):
        common = dict(
            gap_start_tick=0, gap_duration_ticks=900,
            scale_pitch_classes=[0, 2, 4, 5, 7, 9, 11],
            chord_pitch_classes=[0, 4, 7], reference_note=60,
        )
        guitar = plan_melody_fill(**common, fill_style="guitar")
        piano = plan_melody_fill(**common, fill_style="piano")
        strings = plan_melody_fill(**common, fill_style="strings")
        self.assertNotEqual([e["midi_note"] for e in guitar["events"]],
                            [e["midi_note"] for e in piano["events"]])
        self.assertEqual({e["articulation"] for e in guitar["events"]}, {"fingerstyle"})
        self.assertEqual({e["articulation"] for e in piano["events"]}, {"staccato"})
        self.assertEqual({e["articulation"] for e in strings["events"]}, {"sustain"})
        self.assertLessEqual(len(strings["events"]), 2)
        self.assertTrue(all(e["duration_ticks"] >= 360 for e in strings["events"]))
        self.assertTrue(all(48 <= e["midi_note"] <= 88 for e in piano["events"]))

    def test_unknown_fill_style_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "fill_style"):
            plan_melody_fill(
                gap_start_tick=0, gap_duration_ticks=240,
                scale_pitch_classes=[0, 2, 4, 5, 7, 9, 11],
                chord_pitch_classes=[0, 4, 7], reference_note=60,
                fill_style="banjo",
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
