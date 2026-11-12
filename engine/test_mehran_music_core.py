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
        self.assertTrue(all(p["midi_notes"][p["peak_note_index"]] == max(p["midi_notes"]) for p in phrases))
        verse_peak = max(max(p["midi_notes"]) for p in verse)
        chorus_peak = max(max(p["midi_notes"]) for p in chorus)
        self.assertGreater(chorus_peak, verse_peak)

    def test_short_phrase_keeps_chord_tone_start_and_cadence(self):
        plan = compose_plan("غم\nشب")
        for phrase in plan["composition"]["melody"]:
            self.assertTrue(phrase["phrase_start_is_chord_tone"])
            self.assertTrue(phrase["phrase_end_is_chord_tone"])
            self.assertGreaterEqual(len(phrase["midi_notes"]), 2)

    def test_punctuation_extends_phrase_ending(self):
        from mehran_music_core import _phrase_durations
        _, plain = _phrase_durations(4, 4, "دل من")
        _, paused = _phrase_durations(4, 4, "دل من،")
        self.assertGreater(paused[-1], plain[-1])

    def test_internal_comma_creates_a_breath_before_the_next_word(self):
        from mehran_music_core import _phrase_durations
        _, plain = _phrase_durations(4, 4, "دل من")
        _, paused = _phrase_durations(4, 4, "دل، من")
        self.assertGreater(paused[1], plain[1])

    def test_word_boundaries_are_reflected_in_phrase_timing(self):
        from mehran_music_core import _phrase_durations
        _, durations = _phrase_durations(5, 5, "دلم گرفته")
        self.assertEqual(len(durations), 5)
        self.assertEqual(sum(durations) % 1920, 0)
        self.assertGreater(durations[-1], durations[0])

    def test_phonetic_layer_reports_written_diacritics_without_claiming_stress(self):
        result = analyze_lyrics("مَن دل")
        words = result["phonetic_analysis"][0]["words"]
        self.assertEqual(words[0]["explicit_short_vowel_marks"], 1)
        self.assertEqual(words[0]["syllable_estimate"], 1)
        self.assertEqual(words[0]["lexical_stress"], "unknown")
        self.assertEqual(words[1]["confidence"], "low")

    def test_curated_lexicon_improves_common_lyric_word_syllables(self):
        result = analyze_lyrics("دلم گرفته برگرد ای عشق")
        words = result["phonetic_analysis"][0]["words"]
        by_word = {word["word"]: word for word in words}
        self.assertEqual(by_word["دلم"]["syllable_estimate"], 2)
        self.assertEqual(by_word["گرفته"]["syllable_estimate"], 3)
        self.assertEqual(by_word["برگرد"]["syllables"], ["bar", "gard"])
        self.assertEqual(by_word["عشق"]["confidence"], "high")
        self.assertEqual(result["lines"][0]["syllable_estimate"], 9)
    def test_phonetic_layer_detects_written_long_vowels(self):
        result = analyze_lyrics("یار و روز")
        words = result["phonetic_analysis"][0]["words"]
        self.assertEqual([word["syllable_estimate"] for word in words], [1, 1, 1])
        by_word = {word["word"]: word for word in words}
        self.assertEqual(by_word["یار"]["method"], "curated_lyric_pronunciation_lexicon_v1")
        self.assertEqual(by_word["روز"]["method"], "curated_lyric_pronunciation_lexicon_v1")
        self.assertEqual(by_word["و"]["method"], "written_long_vowels_only_v1")

    def test_phonetic_layer_normalizes_arabic_characters(self):
        result = analyze_lyrics("يَك")
        word = result["phonetic_analysis"][0]["words"][0]
        self.assertEqual(word["word"], "یَک")
        self.assertEqual(word["explicit_short_vowel_marks"], 1)

    def test_composition_maps_every_melody_note_to_a_lyric_syllable(self):
        plan = compose_plan("دلم گرفته، برگرد ای عشق")
        phrase = plan["composition"]["melody"][0]
        note_map = phrase["note_lyric_map"]
        alignment = phrase["word_note_alignment"]
        self.assertEqual(len(note_map), len(phrase["midi_notes"]))
        self.assertEqual([item["note_index"] for item in note_map],
                         list(range(len(phrase["midi_notes"]))))
        self.assertEqual([item["word"] for item in alignment],
                         ["دلم", "گرفته", "برگرد", "ای", "عشق"])
        self.assertEqual(alignment[0]["syllable_estimate"], 2)
        self.assertEqual(alignment[1]["syllables"], ["ge", "ref", "te"])
        self.assertEqual(note_map[0]["word"], "دلم")
        self.assertEqual(note_map[0]["tick_start"], 0)
        self.assertEqual(note_map[-1]["tick_end"], phrase["duration_ticks"])
        self.assertTrue(all(item["tick_start"] < item["tick_end"]
                            for item in note_map))
        self.assertTrue(all(note_map[i]["tick_end"] == note_map[i + 1]["tick_start"]
                            for i in range(len(note_map) - 1)))
        self.assertTrue(all(item["note_start"] < item["note_end"]
                            for item in alignment))
        self.assertTrue(all(item["syllable_token"] is None
                            or isinstance(item["syllable_token"], str)
                            for item in note_map))
        syllable_map = phrase["syllable_note_map"]
        self.assertEqual(len(syllable_map), phrase["syllable_estimate"])
        self.assertEqual([item["syllable_index"] for item in syllable_map],
                         list(range(phrase["syllable_estimate"])))
        self.assertTrue(all(0 <= item["note_index"] < len(note_map)
                            for item in syllable_map))
        self.assertEqual(note_map[0]["bar_index"], 0)
        self.assertEqual(note_map[0]["beat_number"], 1)
        self.assertEqual(note_map[0]["beat_strength"], "strong")
        self.assertTrue(all(item["beat_number"] in (1, 2, 3, 4)
                            for item in note_map))
        self.assertTrue(all(item["bar_index"] >= 0 for item in note_map))

    def test_unknown_words_are_aligned_without_fake_phonetic_tokens(self):
        plan = compose_plan("پرواز خیالی")
        phrase = plan["composition"]["melody"][0]
        self.assertTrue(phrase["word_note_alignment"])
        self.assertTrue(all(item["confidence"] == "low"
                            for item in phrase["word_note_alignment"]))
        self.assertTrue(all(item["syllables"] is None
                            for item in phrase["word_note_alignment"]))

    def test_line_punctuation_creates_explicit_post_phrase_breath(self):
        plan = compose_plan("دلم گرفته،\\nبرگرد ای عشق؟\\nبه خانه برگرد")
        phrases = plan["composition"]["melody"]
        self.assertEqual(phrases[0]["phrase_pause_ticks"], 120)
        self.assertEqual(phrases[0]["breath_after_phrase"], "short")
        self.assertEqual(phrases[1]["phrase_pause_ticks"], 360)
        self.assertEqual(phrases[1]["breath_after_phrase"], "full")
        self.assertEqual(phrases[2]["phrase_pause_ticks"], 0)

    def test_phrase_end_gets_longer_cadence(self):
        plan = compose_plan("دلم گرفته\nبرگرد ای عشق")
        for phrase in plan["composition"]["melody"]:
            durations = phrase["note_durations_ticks"]
            self.assertGreater(durations[-1], durations[0])


if __name__ == "__main__":
    unittest.main()
