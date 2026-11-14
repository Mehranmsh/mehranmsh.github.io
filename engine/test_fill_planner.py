import unittest

from fill_planner import plan_melody_fill
from persian_modal_planner import resolve_persian_modal_profile


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

    def test_persian_instrument_profiles_use_catalog_articulations_and_registers(self):
        common = dict(
            gap_start_tick=0, gap_duration_ticks=1000,
            scale_pitch_classes=[0, 2, 4, 5, 7, 9, 11],
            chord_pitch_classes=[0, 4, 7], reference_note=60,
        )
        expected = {
            "tar": {"mezrab_down", "mezrab_up"},
            "setar": {"mezrab_down", "mezrab_up"},
            "santur": {"soft_mallet", "hard_mallet", "roll"},
            "kamancheh": {"short_bow", "long_bow"},
        }
        ranges = {"tar": (48, 84), "setar": (55, 88),
                  "santur": (55, 90), "kamancheh": (48, 84)}
        for style, articulations in expected.items():
            with self.subTest(style=style):
                result = plan_melody_fill(**common, fill_style=style)
                self.assertTrue(result["events"])
                self.assertTrue({e["articulation"] for e in result["events"]} <= articulations)
                self.assertTrue(all(ranges[style][0] <= e["midi_note"] <= ranges[style][1]
                                    for e in result["events"]))
        self.assertEqual(
            [e["articulation"] for e in plan_melody_fill(**common, fill_style="tar")["events"]][:2],
            ["mezrab_down", "mezrab_up"],
        )
        self.assertEqual(
            [e["articulation"] for e in plan_melody_fill(**common, fill_style="kamancheh")["events"]],
            ["short_bow", "long_bow"],
        )

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


    def test_persian_modal_profiles_have_distinct_transposed_pitch_sets(self):
        shur = resolve_persian_modal_profile("shur", 0)
        homayun = resolve_persian_modal_profile("homayun", 0)
        mahour_g = resolve_persian_modal_profile("mahour", 7)
        self.assertNotEqual(shur["scale_pitch_classes"], homayun["scale_pitch_classes"])
        self.assertEqual(mahour_g["scale_pitch_classes"], (7, 9, 11, 0, 2, 4, 6))
        self.assertEqual(shur["final_pitch_class"], 0)
        self.assertEqual(shur["tuning"], "12tet_approximation")
        self.assertFalse(shur["microtonal_audio_rendered"])

    def test_modal_fill_ends_on_the_profile_finalis(self):
        result = plan_melody_fill(
            gap_start_tick=0, gap_duration_ticks=900,
            scale_pitch_classes=[0, 2, 4, 5, 7, 9, 11],
            chord_pitch_classes=[0, 4, 7], reference_note=64,
            fill_style="tar", modal_profile="shur", modal_tonic_pc=2,
        )
        self.assertTrue(result["events"])
        self.assertEqual(result["events"][-1]["midi_note"] % 12, 2)
        self.assertEqual(result["modal_profile"], "shur")
        self.assertEqual(result["modal_tuning"], "12tet_approximation")
        self.assertFalse(result["microtonal_audio_rendered"])

    def test_unknown_persian_modal_profile_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "persian_dastgah"):
            resolve_persian_modal_profile("invented_mode", 0)



    def test_modal_degree_cents_are_attached_to_matching_fill_degrees(self):
        result = plan_melody_fill(
            gap_start_tick=0, gap_duration_ticks=900,
            scale_pitch_classes=[0, 2, 4, 5, 7, 9, 11],
            chord_pitch_classes=[0, 4, 7], reference_note=64,
            fill_style="tar", modal_profile="shur", modal_tonic_pc=2,
            modal_degree_cents={1: 50, 4: -50},
        )
        self.assertTrue(result["events"])
        for event in result["events"]:
            expected = {4: 50.0, 9: -50.0}.get(event["midi_note"] % 12, 0.0)
            self.assertEqual(event["pitch_cents"], expected)

    def test_modal_degree_cents_reject_invalid_values(self):
        with self.assertRaisesRegex(ValueError, "persian_degree_cents"):
            resolve_persian_modal_profile("shur", 0, {7: 50})
        with self.assertRaisesRegex(ValueError, "persian_degree_cents"):
            resolve_persian_modal_profile("shur", 0, {2: 150})

if __name__ == "__main__":
    unittest.main()
