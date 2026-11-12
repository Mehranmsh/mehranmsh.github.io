import tempfile
import unittest
from pathlib import Path

from mehran_music_core import compose_plan
from midi_renderer import PPQ, _bass_pattern, _drum_bar, _groove_velocity, _guitar_bar, _piano_bar, _string_pad_bar, _melody_velocity, _section_dynamics, render_midi


class MidiRendererTests(unittest.TestCase):
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
            self.assertEqual(len(notes), 3)
            self.assertEqual(notes, sorted(notes))
            self.assertLessEqual(notes[-1] - notes[0], 19)

    def test_chord_voicings_report_their_inversion(self):
        plan = compose_plan("دلم گرفته\nاز این شب سرد\nبرگرد ای عشق\nبه خانه برگرد")
        with tempfile.TemporaryDirectory() as folder:
            result = render_midi(plan, Path(folder) / "inversions.mid")
        self.assertTrue(result["chord_voicings"])
        for item in result["chord_voicings"]:
            self.assertIn(item["inversion"], ("root", "first", "second"))
            self.assertEqual(len(item["midi_notes"]), 3)

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

if __name__ == "__main__":
    unittest.main()
