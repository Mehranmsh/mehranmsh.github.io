import tempfile
import unittest
from pathlib import Path

from mehran_music_core import compose_plan
from midi_renderer import PPQ, _bass_pattern, _drum_bar, _groove_velocity, _guitar_bar, _piano_bar, _string_pad_bar, _melody_velocity, _parse_chord, _section_dynamics, _transition_dynamics, render_midi


class MidiRendererTests(unittest.TestCase):
    def test_curated_lexical_stress_receives_midi_velocity_accent(self):
        unstressed = _melody_velocity(88, 0, lexical_stress=False)
        stressed = _melody_velocity(88, 0, lexical_stress=True)
        self.assertGreater(stressed, unstressed)
        self.assertLessEqual(stressed, 127)

    def test_beat_aligned_lexical_stress_gets_controlled_extra_accent(self):
        plain = _melody_velocity(88, 0)
        lexical = _melody_velocity(88, 0, lexical_stress=True)
        aligned = _melody_velocity(
            88, 0, lexical_stress=True, stress_beat_aligned=True
        )
        self.assertGreater(lexical, plain)
        self.assertGreater(aligned, lexical)
        self.assertLessEqual(aligned, 127)

    def test_section_transition_shapes_only_the_final_accompaniment_bar(self):
        base = {"melody": 1.0, "chords": 0.9, "bass": 0.8, "drums": 0.7}
        transition = {"energy_change": 0.12}
        unchanged = _transition_dynamics(
            base, transition, is_transition_bar=False
        )
        lifted = _transition_dynamics(
            base, transition, is_transition_bar=True
        )
        self.assertEqual(unchanged, base)
        self.assertGreater(lifted["chords"], base["chords"])
        self.assertGreater(lifted["bass"], base["bass"])
        self.assertGreater(lifted["drums"], base["drums"])
        self.assertEqual(lifted["melody"], base["melody"])
        eased = _transition_dynamics(
            base, {"energy_change": -0.5}, is_transition_bar=True
        )
        self.assertGreaterEqual(eased["drums"], base["drums"] * 0.96)
        capped = _transition_dynamics(
            base, {"energy_change": 1.0}, is_transition_bar=True
        )
        self.assertLessEqual(capped["drums"], base["drums"] * 1.04)

    def test_renderer_uses_phrase_level_cadence_chord(self):
        plan = compose_plan("دلم گرفته\nبرگرد ای عشق", target_bpm=84)
        plan["composition"]["melody"][0]["chord"] = "F"
        with tempfile.TemporaryDirectory() as folder:
            result = render_midi(plan, Path(folder) / "cadence.mid")
        self.assertEqual(result["chord_voicings"][0]["symbol"], "F")

    def test_renders_seven_track_standard_midi_with_arrangement(self):
        plan = compose_plan("دلم گرفته\nاز این شب سرد\nبرگرد ای عشق\nبه خانه برگرد",
                            title="برگرد", target_bpm=84)
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "song.mid"
            result = render_midi(plan, target)
            data = target.read_bytes()
        self.assertEqual(data[:4], b"MThd")
        self.assertEqual(int.from_bytes(data[10:12], "big"), 7)
        self.assertEqual(result["tracks"], 7)
        self.assertGreater(result["piano_note_events"], 0)
        self.assertGreater(result["guitar_note_events"], 0)
        self.assertGreater(result["note_events"], 0)
        self.assertGreater(result["bass_note_events"], 0)
        self.assertGreater(result["drum_hits"], 0)
        self.assertEqual(result["drum_channel"], 10)
        self.assertGreater(len(data), 40)
        self.assertGreater(result["duration_seconds"], 0)

    def test_long_lyric_line_gets_more_than_one_bar(self):
        plan = compose_plan("این یک مصرع بسیار بلند است که باید زمان بیشتری بگیرد")
        phrase = plan["composition"]["melody"][0]
        self.assertGreaterEqual(phrase["bar_count"], 2)
        self.assertEqual(sum(phrase["note_durations_ticks"]), phrase["duration_ticks"])

    def test_renderer_preserves_punctuation_breath_between_phrases(self):
        plan = compose_plan("دلم گرفته،\nبرگرد ای عشق؟")
        phrases = plan["composition"]["melody"]
        with tempfile.TemporaryDirectory() as folder:
            result = render_midi(plan, Path(folder) / "breaths.mid")
        expected_ticks = sum(p["duration_ticks"] + p["phrase_pause_ticks"]
                             for p in phrases)
        self.assertEqual(result["duration_ticks"], expected_ticks)
        self.assertEqual(phrases[0]["phrase_pause_ticks"], 120)
        self.assertEqual(phrases[1]["phrase_pause_ticks"], 360)

    def test_chord_voicings_use_close_voice_leading(self):
        plan = compose_plan("دلم گرفته\nاز این شب سرد\nبرگرد ای عشق\nبه خانه برگرد")
        with tempfile.TemporaryDirectory() as folder:
            result = render_midi(plan, Path(folder) / "song.mid")
        voicings = result["chord_voicings"]
        self.assertGreaterEqual(len(voicings), 4)
        for voicing in voicings:
            notes = voicing["midi_notes"]
            self.assertIn(len(notes), (3, 4))
            self.assertEqual(notes, sorted(notes))
            self.assertLessEqual(notes[-1] - notes[0], 19)

    def test_chord_voicings_report_their_inversion(self):
        plan = compose_plan("دلم گرفته\nاز این شب سرد\nبرگرد ای عشق\nبه خانه برگرد")
        with tempfile.TemporaryDirectory() as folder:
            result = render_midi(plan, Path(folder) / "inversions.mid")
        self.assertTrue(result["chord_voicings"])
        for item in result["chord_voicings"]:
            self.assertIn(item["inversion"], ("root", "first", "second"))
            self.assertIn(len(item["midi_notes"]), (3, 4))

    def test_seventh_chord_qualities_have_distinct_intervals(self):
        self.assertEqual(_parse_chord("Cmaj7")[1], (0, 4, 7, 11))
        self.assertEqual(_parse_chord("Am7")[1], (0, 3, 7, 10))
        self.assertEqual(_parse_chord("G7")[1], (0, 4, 7, 10))
        self.assertEqual(_parse_chord("Bdim7")[1], (0, 3, 6, 9))

    def test_dominant_seventh_chord_renders_all_four_voices(self):
        plan = compose_plan("دلم گرفته\nبرگرد ای عشق", target_bpm=84)
        plan["composition"]["melody"][0]["chord"] = "G7"
        with tempfile.TemporaryDirectory() as folder:
            result = render_midi(plan, Path(folder) / "seventh.mid")
        voicing = result["chord_voicings"][0]
        self.assertEqual(voicing["symbol"], "G7")
        self.assertEqual(len(voicing["midi_notes"]), 4)
        self.assertEqual({note % 12 for note in voicing["midi_notes"]},
                         {7, 11, 2, 5})
        self.assertIn(voicing["inversion"], ("root", "first", "second", "third"))

    def test_chorus_bass_has_more_movement_than_verse(self):
        verse_events, chorus_events = [], []
        verse_count = _bass_pattern(9, 0, verse_events, chorus=False)
        chorus_count = _bass_pattern(9, 0, chorus_events, chorus=True)
        self.assertEqual(verse_count, 3)
        self.assertEqual(chorus_count, 4)
        self.assertGreater(
            max(event[2][2] for event in chorus_events if event[2][0] & 0xF0 == 0x90),
            max(event[2][2] for event in verse_events if event[2][0] & 0xF0 == 0x90),
        )

    def test_bass_tracks_each_chord_root_and_uses_sparse_bridge_pattern(self):
        events = []
        count = _bass_pattern(9, 0, events, bridge=True)
        note_ons = [event for event in events if event[2][0] & 0xF0 == 0x90]
        self.assertEqual(count, 2)
        self.assertEqual([event[2][1] for event in note_ons], [45, 52])
        self.assertEqual([event[0] for event in note_ons], [0, PPQ * 2])

    def test_bass_can_anchor_first_note_to_chord_inversion(self):
        events = []
        _bass_pattern(0, 0, events, bass_root_pc=4)
        note_on = next(event for event in events if event[2][0] & 0xF0 == 0x90)
        self.assertEqual(note_on[2][1], 40)

    def test_inverted_bass_uses_chord_tones_relative_to_bass_note(self):
        events = []
        _bass_pattern(0, 0, events, bass_root_pc=4,
                      bass_third_interval=3, bass_fifth_interval=8)
        note_ons = [message[1] for _, _, message in events
                    if message[0] & 0xF0 == 0x90]
        self.assertEqual(note_ons, [40, 43, 48])

    def test_bass_uses_major_or_minor_third_from_chord_quality(self):
        major_events, minor_events = [], []
        _bass_pattern(9, 0, major_events, third_interval=4)
        _bass_pattern(9, 0, minor_events, third_interval=3)
        major_on = [e for e in major_events if e[2][0] & 0xF0 == 0x90]
        minor_on = [e for e in minor_events if e[2][0] & 0xF0 == 0x90]
        self.assertEqual(major_on[1][2][1] % 12, (45 + 4) % 12)
        self.assertEqual(minor_on[1][2][1] % 12, (45 + 3) % 12)

    def test_chorus_bass_places_a_syncopated_fifth_between_kick_anchors(self):
        events = []
        _bass_pattern(0, 0, events, chorus=True)
        note_ons = [event for event in events if event[2][0] & 0xF0 == 0x90]
        self.assertEqual([event[0] for event in note_ons],
                         [0, PPQ + PPQ // 2, PPQ * 2, PPQ * 3])
        self.assertEqual(note_ons[1][2][1], 43)
        self.assertEqual(note_ons[2][2][1], 48)

    def test_chorus_bass_reinforces_main_kick_positions(self):
        bass_events, drum_events = [], []
        _bass_pattern(0, 0, bass_events, chorus=True)
        _drum_bar(0, drum_events, chorus=True)
        bass_starts = {tick for tick, _, message in bass_events
                       if message[0] & 0xF0 == 0x90}
        kick_starts = {tick for tick, _, message in drum_events
                       if message[0] & 0xF0 == 0x90 and message[1] == 36}
        self.assertTrue({0, PPQ + PPQ // 2, PPQ * 2}.issubset(bass_starts))
        self.assertTrue({0, PPQ + PPQ // 2, PPQ * 2}.issubset(kick_starts))

    def test_chorus_drums_are_fuller_and_phrase_end_gets_a_fill(self):
        verse_events, chorus_events, fill_events = [], [], []
        verse_count = _drum_bar(0, verse_events)
        chorus_count = _drum_bar(0, chorus_events, chorus=True)
        fill_count = _drum_bar(
            0, fill_events, chorus=True, bar_index=3, phrase_bars=4)
        self.assertGreater(chorus_count, verse_count)
        self.assertGreater(fill_count, chorus_count)

    def test_bridge_drums_are_reduced(self):
        verse_events, bridge_events = [], []
        verse_count = _drum_bar(0, verse_events)
        bridge_count = _drum_bar(0, bridge_events, bridge=True)
        self.assertLess(bridge_count, verse_count)

    def test_flat_chord_is_supported(self):
        plan = compose_plan("فریاد\nخشم\nآتش\nجنگ")
        with tempfile.TemporaryDirectory() as folder:
            result = render_midi(plan, Path(folder) / "song.mid")
        self.assertTrue(any(item["symbol"] == "Bb" for item in result["chord_voicings"]))

    def test_rejects_malformed_plan(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                render_midi({}, Path(folder) / "bad.mid")

    def test_rejects_out_of_range_notes(self):
        plan = compose_plan("یک شعر")
        plan["composition"]["melody"][0]["midi_notes"] = [120]
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                render_midi(plan, Path(folder) / "bad.mid")

    def test_rejects_duration_mismatch(self):
        plan = compose_plan("یک شعر کوتاه")
        plan["composition"]["melody"][0]["note_durations_ticks"] = [1]
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                render_midi(plan, Path(folder) / "bad.mid")

    def test_melody_velocity_accents_strong_beats_peak_and_cadence(self):
        downbeat = _melody_velocity(88, 0)
        second_beat = _melody_velocity(88, 480)
        third_beat = _melody_velocity(88, 960)
        peak = _melody_velocity(88, 960, is_peak=True)
        cadence = _melody_velocity(88, 960, is_cadence=True)
        self.assertGreater(downbeat, second_beat)
        self.assertGreater(third_beat, second_beat)
        self.assertGreater(peak, third_beat)
        self.assertGreater(cadence, third_beat)
        self.assertLessEqual(_melody_velocity(120, 0, section_scale=1.2), 127)


    def test_structural_cadence_release_softens_only_as_a_bounded_scale(self):
        normal = _melody_velocity(88, 960, is_cadence=True)
        section_end = _melody_velocity(
            88, 960, is_cadence=True, cadence_release_scale=0.97
        )
        final_end = _melody_velocity(
            88, 960, is_cadence=True, cadence_release_scale=0.90
        )
        self.assertGreater(normal, section_end)
        self.assertGreater(section_end, final_end)
        self.assertGreater(
            _melody_velocity(88, 960, is_cadence=True, cadence_release_scale=0.1),
            0,
        )

    def test_groove_velocity_accents_downbeats_and_softens_offbeats(self):
        downbeat = _groove_velocity(80, 0)
        second_beat = _groove_velocity(80, 1)
        offbeat = _groove_velocity(80, 0, subdivision=1)
        self.assertGreater(downbeat, second_beat)
        self.assertGreater(downbeat, offbeat)
        self.assertLessEqual(_groove_velocity(120, 0, section_scale=1.2), 127)

    def test_guitar_arrangement_changes_by_song_section(self):
        chord = (60, 64, 67)
        verse, chorus, bridge = [], [], []
        verse_count = _guitar_bar(chord, 0, verse, section="verse")
        chorus_count = _guitar_bar(chord, 0, chorus, section="chorus")
        bridge_count = _guitar_bar(chord, 0, bridge, section="bridge")
        self.assertEqual(verse_count, 8)
        self.assertEqual(chorus_count, 12)
        self.assertEqual(bridge_count, 2)
        self.assertEqual(len([e for e in verse if e[2][0] & 0xF0 == 0x90]), 8)
        self.assertEqual(len([e for e in chorus if e[2][0] & 0xF0 == 0x90]), 12)

    def test_piano_arrangement_changes_by_song_section(self):
        chord = (60, 64, 67)
        verse, chorus, bridge = [], [], []
        verse_count = _piano_bar(chord, 0, verse, section="verse")
        chorus_count = _piano_bar(chord, 0, chorus, section="chorus")
        bridge_count = _piano_bar(chord, 0, bridge, section="bridge")
        self.assertEqual(verse_count, 4)
        self.assertEqual(chorus_count, 10)
        self.assertEqual(bridge_count, 2)
        self.assertTrue(all(event[2][0] & 0x0F == 4 for event in verse if event[2][0] & 0xF0 == 0x90))

    def test_string_pad_changes_voicing_density_by_section(self):
        chord = (60, 64, 67)
        verse, chorus, bridge = [], [], []
        verse_count = _string_pad_bar(chord, 0, verse, section="verse")
        chorus_count = _string_pad_bar(chord, 0, chorus, section="chorus")
        bridge_count = _string_pad_bar(chord, 0, bridge, section="bridge")
        self.assertEqual(verse_count, 3)
        self.assertEqual(chorus_count, 4)
        self.assertEqual(bridge_count, 2)
        self.assertTrue(all(event[2][0] & 0x0F == 1 for event in verse if event[2][0] & 0xF0 == 0x90))
        self.assertGreater(max(e[2][2] for e in chorus if e[2][0] & 0xF0 == 0x90),
                           max(e[2][2] for e in verse if e[2][0] & 0xF0 == 0x90))

    def test_each_arrangement_track_has_its_own_general_midi_program(self):
        plan = compose_plan("دلم گرفته\nاز این شب سرد\nبرگرد ای عشق\nبه خانه برگرد")
        with tempfile.TemporaryDirectory() as folder:
            data = (Path(folder) / "programs.mid")
            render_midi(plan, data)
            midi = data.read_bytes()
        for program_change in (bytes((0xC0, 80)), bytes((0xC1, 48)),
                               bytes((0xC2, 33)), bytes((0xC3, 25)),
                               bytes((0xC4, 0))):
            self.assertIn(program_change, midi)


    def test_melody_articulations_are_preserved_as_midi_marker_metadata(self):
        plan = compose_plan("دلم گرفته\\nبرگرد ای عشق", target_bpm=84)
        phrase = plan["composition"]["melody"][0]
        phrase["note_lyric_map"][0]["articulation"] = "staccato"
        phrase["note_lyric_map"][0]["articulation_reason"] = "short_note"
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "articulation.mid"
            result = render_midi(plan, target)
            data = target.read_bytes()
        self.assertIn(bytes((0xff, 0x06)), data)
        self.assertIn(b"articulation=staccato;note=", data)
        self.assertGreaterEqual(result["articulation_markers"], 1)
        self.assertIn("metadata only", result["articulation_rendering"])


    def test_per_note_dynamics_velocity_is_preserved_in_midi_marker(self):
        plan = compose_plan("دلم گرفته\\nبرگرد ای عشق", target_bpm=84)
        item = plan["composition"]["melody"][0]["note_lyric_map"][0]
        item.update({"dynamics_velocity": 110, "dynamic_mark": "f"})
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "dynamics.mid"
            render_midi(plan, target)
            data = target.read_bytes()
        self.assertIn(b"dynamics_velocity=110;dynamic_mark=f", data)

    def test_articulation_performance_profile_is_preserved_in_midi_marker(self):
        plan = compose_plan("دلم گرفته\\nبرگرد ای عشق", target_bpm=84)
        item = plan["composition"]["melody"][0]["note_lyric_map"][0]
        item.update({"articulation": "staccato", "gate_ratio": 0.62, "release_ms": 12})
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "performance.mid"
            render_midi(plan, target)
            data = target.read_bytes()
        self.assertIn(b"gate_ratio=0.62;release_ms=12", data)


    def test_melody_pitch_cents_emits_pitch_bend_and_configures_range(self):
        import tempfile
        from pathlib import Path
        from mehran_music_core import compose_plan
        from midi_renderer import render_midi

        plan = compose_plan("یک شب آرام\\nدر این سکوت")
        plan["composition"]["melody"][0]["note_lyric_map"][0]["pitch_cents"] = 50
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "microtonal.mid"
            result = render_midi(plan, path)
            data = path.read_bytes()
        self.assertIn(bytes((0xB0, 101, 0, 0xB0, 100, 0,
                             0xB0, 6, 2, 0xB0, 38, 0)), data)
        self.assertIn(bytes((0xE0, 0, 96)), data)
        self.assertIn("pitch_cents", result["pitch_bend_support"])

    def test_midi_rejects_pitch_cents_outside_configured_bend_range(self):
        import tempfile
        from pathlib import Path
        from mehran_music_core import compose_plan
        from midi_renderer import render_midi

        plan = compose_plan("یک شب آرام\\nدر این سکوت")
        plan["composition"]["melody"][0]["note_lyric_map"][0]["pitch_cents"] = 201
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, "pitch_cents"):
                render_midi(plan, Path(folder) / "invalid.mid")

if __name__ == "__main__":
    unittest.main()
