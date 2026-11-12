import unittest

from mehran_music_core import analyze_lyrics, compose_plan


class IndependentMusicCoreTests(unittest.TestCase):
    def test_rejects_empty_lyrics(self):
        with self.assertRaises(ValueError):
            analyze_lyrics("  \n ")

    def test_analyzes_persian_lyrics_without_external_services(self):
        result = analyze_lyrics("دلم گرفته از این شب\nبرگرد به خانه")
        self.assertEqual(result["language"], "fa")
        self.assertEqual(result["line_count"], 2)
        self.assertIn(result["mood"], {"sad", "neutral"})

    def test_builds_composition_plan_and_preserves_lines(self):
        lyrics = "دلم گرفته\nاز این شب سرد\nبرگرد ای عشق\nبه خانه برگرد"
        plan = compose_plan(lyrics, title="برگرد", target_bpm=84)
        self.assertEqual(plan["engine"], "MEHRAN_INDEPENDENT_COMPOSITION_CORE")
        self.assertEqual(plan["title"], "برگرد")
        self.assertEqual(plan["composition"]["tempo_bpm"], 84)
        self.assertEqual(len(plan["composition"]["melody"]), 4)
        self.assertFalse(plan["audio_rendered"])
        self.assertEqual(plan["status"], "composition_plan_only")

    def test_melody_phrase_starts_and_resolves_on_chord_tones(self):
        plan = compose_plan("دلم گرفته\nبرگرد ای عشق\nبه خانه برگرد")
        for phrase in plan["composition"]["melody"]:
            self.assertTrue(phrase["phrase_start_is_chord_tone"])
            self.assertTrue(phrase["phrase_end_is_chord_tone"])

    def test_flat_chord_melody_resolves_to_correct_flat_chord_tones(self):
        plan = compose_plan("فریاد\nخشم\nآتش\nجنگ")
        phrases = plan["composition"]["melody"]
        self.assertEqual(plan["analysis"]["mood"], "angry")
        self.assertEqual(phrases[1]["chord"], "Bb")
        self.assertTrue(phrases[1]["phrase_start_is_chord_tone"])
        self.assertTrue(phrases[1]["phrase_end_is_chord_tone"])

    def test_rejects_invalid_tempo(self):
        with self.assertRaises(ValueError):
            compose_plan("یک شعر", target_bpm=300)

    def test_deterministic_output(self):
        lyrics = "تو در دل منی\nبهار منی"
        self.assertEqual(compose_plan(lyrics), compose_plan(lyrics))


    def test_chorus_has_a_higher_contour_and_explicit_peak(self):
        plan = compose_plan("دلم گرفته\nشب سرد و خاموش\nتو برگرد ای عشق\nبه خانه برگرد")
        phrases = plan["composition"]["melody"]
        verse = [p for p in phrases if "chorus" not in p["section"]]
        chorus = [p for p in phrases if "chorus" in p["section"]]
        self.assertTrue(verse)
        self.assertTrue(chorus)
        self.assertTrue(all(p["contour_type"] == "restrained_wave" for p in verse))
        self.assertTrue(all(p["contour_type"] == "rising_peak_then_fall" for p in chorus))
        self.assertTrue(all(0 <= p["peak_note_index"] < len(p["midi_notes"]) for p in phrases))
        self.assertGreater(
            sum(sum(p["midi_notes"]) / len(p["midi_notes"]) for p in chorus) / len(chorus),
            sum(sum(p["midi_notes"]) / len(p["midi_notes"]) for p in verse) / len(verse),
        )

    def test_phrase_end_gets_longer_cadence(self):
        plan = compose_plan("دلم گرفته\nبرگرد ای عشق")
        for phrase in plan["composition"]["melody"]:
            durations = phrase["note_durations_ticks"]
            self.assertGreater(durations[-1], durations[0])


if __name__ == "__main__":
    unittest.main()
