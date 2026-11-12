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

    def test_word_note_ranges_are_contiguous_and_do_not_overlap(self):
        from mehran_music_core import _align_words_to_notes
        aligned = _align_words_to_notes("دلم گرفته برگرد ای عشق", 9)
        words = aligned["word_note_alignment"]
        self.assertEqual(words[0]["note_start"], 0)
        self.assertEqual(words[-1]["note_end"], 9)
        for previous, current in zip(words, words[1:]):
            self.assertEqual(previous["note_end"], current["note_start"])
        for item in aligned["note_lyric_map"]:
            word = words[item["word_index"]]
            self.assertGreaterEqual(item["note_index"], word["note_start"])
            self.assertLess(item["note_index"], word["note_end"])
        for syllable in aligned["syllable_note_map"]:
            word = words[syllable["word_index"]]
            self.assertGreaterEqual(syllable["note_index"], word["note_start"])
            self.assertLess(syllable["note_index"], word["note_end"])
            self.assertEqual(syllable["mapping"], "word_preserving_syllable_to_note_v2")

    def test_word_alignment_tokenizes_latin_and_persian_words(self):
        from mehran_music_core import _align_words_to_notes
        aligned = _align_words_to_notes("hello برگرد", 4)
        self.assertEqual([item["word"] for item in aligned["word_note_alignment"]],
                         ["hello", "برگرد"])
        self.assertEqual(aligned["word_note_alignment"][1]["syllables"],
                         ["bar", "gard"])

    def test_melodic_motif_restarts_at_section_boundaries(self):
        lyrics = "\n".join([
            "دلم گرفته از این شب", "صدای باران می‌آید",
            "برگرد به خانه", "هنوز چشم به راهت",
            "دلم گرفته از این شب", "صدای باران می‌آید",
            "برگرد به خانه", "هنوز چشم به راهت",
            "دوباره برگرد ای عشق", "چراغ خانه روشن است",
        ])
        plan = compose_plan(lyrics)
        phrases = plan["composition"]["melody"]
        sections = plan["composition"]["sections"]
        for section in sections:
            phrase = phrases[section["start_line"]]
            self.assertEqual(phrase["melodic_motif_scope"], section["name"])
            self.assertEqual(phrase["melodic_motif_slot"], 0)
            expected = "lifted" if "chorus" in section["name"] else "midrange"
            self.assertEqual(phrase["section_register"], expected)

    def test_melodic_leap_smoothing_preserves_phrase_anchors(self):
        plan = compose_plan(
            "دلم گرفته از این شب\nبرگرد به خانه\nصدای باران می‌آید\nهنوز چشم به راهت"
        )
        for phrase in plan["composition"]["melody"]:
            notes = phrase["midi_notes"]
            self.assertTrue(all(0 <= note <= 127 for note in notes))
            for index in range(1, len(notes) - 1):
                if phrase["note_lyric_map"][index]["beat_strength"] != "strong" and index != phrase["peak_note_index"]:
                    self.assertLessEqual(abs(notes[index] - notes[index - 1]), 7)

    def test_primary_downbeats_land_on_current_chord_tones(self):
        plan = compose_plan(
            "دلم گرفته از این شب\nبرگرد به خانه\nصدای باران می‌آید\nهنوز چشم به راهت"
        )
        for phrase in plan["composition"]["melody"]:
            chord_classes = set()
            chord = phrase["chord"]
            roots = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
            root = roots[chord[0]]
            suffix = chord[1:]
            if suffix.startswith("b"):
                root -= 1
            elif suffix.startswith("#"):
                root += 1
            intervals = (0, 3, 7) if suffix.startswith("m") else (0, 4, 7)
            if "7" in suffix:
                intervals += (10,)
            chord_classes = {(root + interval) % 12 for interval in intervals}
            for note, item in zip(phrase["midi_notes"], phrase["note_lyric_map"]):
                if item["beat_strength"] == "strong":
                    self.assertIn(note % 12, chord_classes)

    def test_curated_persian_lexical_stress_maps_to_syllable_and_note(self):
        plan = compose_plan("برگرد به خانه")
        phrase = plan["composition"]["melody"][0]
        stressed = [item for item in phrase["syllable_note_map"]
                    if item["word"] == "برگرد"]
        self.assertEqual(len(stressed), 2)
        self.assertEqual([item["is_lexically_stressed"] for item in stressed],
                         [False, True])
        self.assertTrue(all(item["stress_confidence"] == "curated"
                            for item in stressed))
        unknown = [item for item in phrase["syllable_note_map"]
                   if item["word"] == "به"]
        self.assertTrue(all(item["is_lexically_stressed"] is None
                            for item in unknown))

    def test_note_map_includes_rhythmic_value_and_articulation(self):
        plan = compose_plan("دلم گرفته از این شب")
        note_map = plan["composition"]["melody"][0]["note_lyric_map"]
        allowed_values = {"whole", "half", "quarter", "eighth", "sixteenth", "short_subdivision"}
        allowed_articulations = {"sustain", "normal", "light"}
        for item in note_map:
            self.assertIn(item["rhythmic_value"], allowed_values)
            self.assertIn(item["articulation_hint"], allowed_articulations)
            self.assertGreater(item["duration_ticks"], 0)

    def test_note_beat_metadata_uses_note_onset_not_note_end(self):
        plan = compose_plan("دلم گرفته از این شب")
        phrase = plan["composition"]["melody"][0]
        note_map = phrase["note_lyric_map"]
        self.assertEqual(note_map[0]["tick_start"], 0)
        self.assertEqual(note_map[0]["bar_index"], 0)
        self.assertEqual(note_map[0]["beat_number"], 1)
        self.assertEqual(note_map[0]["beat_strength"], "strong")
        self.assertEqual(note_map[0]["onset_accent"], "primary")
        for previous, current in zip(note_map, note_map[1:]):
            self.assertEqual(previous["tick_end"], current["tick_start"])

    def test_punctuation_guides_harmonic_phrase_cadence(self):
        plan = compose_plan(
            "دلم گرفته،\nبرگرد ای عشق؟\nبه خانه برگرد؛\nشب سرد و خاموش"
        )
        phrases = plan["composition"]["melody"]
        progression = plan["composition"]["chord_progression"]
        self.assertEqual(phrases[0]["harmonic_cadence"], "dominant_suspension")
        self.assertEqual(phrases[0]["chord"], progression[-1])
        self.assertEqual(phrases[1]["harmonic_cadence"], "tonic_resolution")
        self.assertEqual(phrases[1]["chord"], progression[0])
        self.assertEqual(phrases[2]["harmonic_cadence"], "mid_phrase_lift")
        self.assertEqual(phrases[3]["harmonic_cadence"], "continuing")

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

    def test_harmonic_metadata_explains_tonal_function_and_phrase_position(self):
        plan = compose_plan("دلم گرفته\nشب سرد\nبرگرد ای عشق\nبه خانه برگرد")
        phrases = plan["composition"]["melody"]
        self.assertEqual(phrases[0]["harmonic_function"], "tonic")
        self.assertEqual(phrases[0]["harmonic_position"]["global_phrase_index"], 0)
        self.assertEqual(phrases[0]["harmonic_position"]["section_phrase_index"], 0)
        self.assertEqual(phrases[1]["harmonic_position"]["progression_slot"], 1)
        self.assertIsInstance(phrases[1]["harmonic_position"]["cadence_override"], bool)
        self.assertTrue(all(p["harmonic_function"] != "unknown" for p in phrases))

    def test_harmonic_function_handles_flat_scale_degrees(self):
        from mehran_music_core import _harmonic_function
        self.assertEqual(_harmonic_function("Bb", "D", "minor"), "submediant")
        self.assertEqual(_harmonic_function("C7", "D", "minor"), "subtonic")

    def test_long_song_sections_separate_second_verse_and_final_chorus(self):
        lyrics = "\n".join([
            "بند اول یک", "بند اول دو",
            "ترجیع یک", "ترجیع دو", "ترجیع سه",
            "بند دوم یک", "ترجیع نهایی یک", "ترجیع نهایی دو",
        ])
        plan = compose_plan(lyrics)
        sections = plan["composition"]["sections"]
        self.assertEqual(
            [section["name"] for section in sections],
            ["verse_1", "chorus", "verse_2", "final_chorus"],
        )
        self.assertEqual(sections[0]["start_line"], 0)
        self.assertEqual(sections[-1]["end_line"], 8)
        self.assertTrue(all(
            sections[index]["end_line"] == sections[index + 1]["start_line"]
            for index in range(len(sections) - 1)
        ))
        phrases = plan["composition"]["melody"]
        self.assertTrue(all(
            phrases[index]["section"] == section["name"]
            for section in sections
            for index in range(section["start_line"], section["end_line"])
        ))
        final_phrases = [p for p in phrases if p["section"] == "final_chorus"]
        verse_two = [p for p in phrases if p["section"] == "verse_2"]
        self.assertTrue(final_phrases)
        self.assertTrue(verse_two)
        self.assertTrue(all(p["contour_type"] == "rising_peak_then_fall"
                            for p in final_phrases))
        self.assertTrue(all(p["contour_type"] == "restrained_wave"
                            for p in verse_two))

    def test_harmonic_progression_restarts_at_each_section_boundary(self):
        lyrics = "\n".join([
            "بند اول یک", "بند اول دو",
            "ترجیع یک", "ترجیع دو", "ترجیع سه",
            "بند دوم یک", "ترجیع نهایی یک", "ترجیع نهایی دو",
        ])
        plan = compose_plan(lyrics)
        phrases = plan["composition"]["melody"]
        progression = plan["composition"]["chord_progression"]
        for section in plan["composition"]["sections"]:
            first = phrases[section["start_line"]]
            self.assertEqual(first["harmonic_position"]["progression_slot"], 0)
            if (first["harmonic_position"]["cadence_override"]
                    or first["structural_cadence"] != "none"):
                self.assertIn(first["chord"], (progression[0], progression[2], progression[-1]))
            else:
                self.assertEqual(first["chord"], progression[0])
            if section["end_line"] - section["start_line"] > 1:
                second = phrases[section["start_line"] + 1]
                self.assertEqual(second["harmonic_position"]["progression_slot"], 1)
                if (second["harmonic_position"]["cadence_override"]
                        or second["structural_cadence"] != "none"):
                    self.assertIn(second["chord"], (progression[0], progression[2], progression[-1]))
                else:
                    self.assertEqual(second["chord"], progression[1])

    def test_long_song_sections_receive_structural_harmonic_cadences(self):
        lyrics = "\n".join([
            "بند اول یک", "بند اول دو",
            "ترجیع یک", "ترجیع دو", "ترجیع سه",
            "بند دوم یک", "ترجیع نهایی یک", "ترجیع نهایی دو",
        ])
        plan = compose_plan(lyrics)
        phrases = plan["composition"]["melody"]
        progression = plan["composition"]["chord_progression"]
        section_ends = [section["end_line"] - 1
                        for section in plan["composition"]["sections"]]
        for phrase_index in section_ends[:-1]:
            phrase = phrases[phrase_index]
            self.assertEqual(phrase["structural_cadence"], "section_dominant")
            self.assertEqual(phrase["chord"], progression[-1])
        final_phrase = phrases[section_ends[-1]]
        self.assertEqual(final_phrase["structural_cadence"], "final_tonic")
        self.assertEqual(final_phrase["chord"], progression[0])

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

    def test_curated_stress_receives_rhythmic_weight(self):
        from mehran_music_core import _phrase_durations
        _, durations = _phrase_durations(3, 4, "برگرد شب")
        self.assertEqual(len(durations), 4)
        self.assertGreater(durations[2], durations[0])
        self.assertEqual(sum(durations), 1920)

    def test_unknown_word_stress_is_not_guessed_for_rhythm(self):
        from mehran_music_core import _phrase_durations
        _, plain = _phrase_durations(3, 4, "پرواز خیالی")
        _, punctuated = _phrase_durations(3, 4, "پرواز، خیالی")
        self.assertEqual(len(plain), len(punctuated))
        self.assertEqual(sum(plain), sum(punctuated))

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
        plan = compose_plan("دلم گرفته،\nبرگرد ای عشق؟\nبه خانه برگرد")
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
