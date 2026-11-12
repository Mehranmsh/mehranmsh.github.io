import json
import math
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank import load_sample_bank
from sample_renderer import _section_kind, build_composition_events, render_composition_to_wav, render_sample_events
from mehran_music_core import compose_plan


class SampleRendererTests(unittest.TestCase):
    def make_wav(self, path, *, channels=1, rate=22050, frames=2205):
        path.parent.mkdir(parents=True, exist_ok=True)
        # Deterministic recorded-sample fixture: a short decaying PCM waveform.
        import math
        import struct
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(channels)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            data = bytearray()
            for i in range(frames):
                value = int(9000 * math.sin(2 * math.pi * 440 * i / rate) *
                            (1.0 - i / frames))
                for _ in range(channels):
                    data.extend(struct.pack("<h", value))
            wav.writeframes(bytes(data))

    def make_bank(self, root):
        self.make_wav(root / "piano" / "c4.wav")
        self.make_wav(root / "electric_bass" / "c3.wav", channels=2)
        (root / "bank.json").write_text(json.dumps({
            "format_version": 1,
            "samples": [
                {"instrument": "piano", "midi_note": 60, "path": "piano/c4.wav"},
                {"instrument": "electric_bass", "midi_note": 48, "path": "electric_bass/c3.wav"}
            ]
        }), encoding="utf-8")
        return load_sample_bank(root)

    def test_renders_non_silent_stereo_pcm_wav_from_recorded_samples(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            output = Path(folder) / "mix.wav"
            result = render_sample_events([
                {"instrument": "piano", "midi_note": 60, "start_seconds": 0,
                 "duration_seconds": 0.08, "velocity": 100},
                {"instrument": "electric_bass", "midi_note": 48, "start_seconds": 0.02,
                 "duration_seconds": 0.08, "velocity": 85},
            ], bank, output, sample_rate=22050)
            with wave.open(str(output), "rb") as wav:
                raw = wav.readframes(wav.getnframes())
                self.assertEqual(wav.getnchannels(), 2)
                self.assertEqual(wav.getsampwidth(), 2)
                self.assertEqual(wav.getframerate(), 22050)
            self.assertTrue(any(raw))
            self.assertEqual(result["events_rendered"], 2)
            self.assertEqual(result["source"], "recorded_sample_bank")

    def test_renderer_blends_two_recorded_velocity_layers_in_overlap(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            layers = ((1, 39), (24, 71), (56, 103), (88, 127))
            samples = []
            for low, high in layers:
                relative = f"piano/c4-{low}-{high}.wav"
                self.make_wav(root / relative, rate=22050, frames=4410)
                samples.append({
                    "instrument": "piano", "midi_note": 60,
                    "velocity_min": low, "velocity_max": high,
                    "path": relative, "articulation": "sustain",
                })
            (root / "bank.json").write_text(json.dumps({
                "format_version": 1, "samples": samples,
            }), encoding="utf-8")
            bank = load_sample_bank(root)
            output = Path(folder) / "crossfade.wav"
            result = render_sample_events([{
                "instrument": "piano", "midi_note": 60,
                "start_seconds": 0, "duration_seconds": 0.08,
                "velocity": 31,
            }], bank, output, sample_rate=22050)

            self.assertEqual(result["events_rendered"], 1)
            self.assertEqual(
                result["sample_selection"]["equal_power_velocity_crossfade_events"], 1
            )
            self.assertEqual(result["sample_selection"]["velocity_layers_rendered"], 2)
            with wave.open(str(output), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 2)
                self.assertTrue(any(wav.readframes(wav.getnframes())))

    def test_renderer_uses_one_velocity_layer_outside_overlap(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            layers = ((1, 39), (24, 71), (56, 103), (88, 127))
            samples = []
            for low, high in layers:
                relative = f"piano/c4-{low}-{high}.wav"
                self.make_wav(root / relative, rate=22050, frames=4410)
                samples.append({
                    "instrument": "piano", "midi_note": 60,
                    "velocity_min": low, "velocity_max": high,
                    "path": relative, "articulation": "sustain",
                })
            (root / "bank.json").write_text(json.dumps({
                "format_version": 1, "samples": samples,
            }), encoding="utf-8")
            bank = load_sample_bank(root)
            output = Path(folder) / "single-layer.wav"
            result = render_sample_events([{
                "instrument": "piano", "midi_note": 60,
                "start_seconds": 0, "duration_seconds": 0.08,
                "velocity": 12,
            }], bank, output, sample_rate=22050)

            self.assertEqual(
                result["sample_selection"]["equal_power_velocity_crossfade_events"], 0
            )
            self.assertEqual(result["sample_selection"]["velocity_layers_rendered"], 1)

    def test_mix_attenuates_overloads_to_the_configured_peak_ceiling(self):
        import array
        from sample_renderer import MAX_PEAK

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            output = Path(folder) / "hot_mix.wav"
            events = [
                {"instrument": "piano", "midi_note": 60, "start_seconds": 0,
                 "duration_seconds": 0.08, "velocity": 127}
                for _ in range(12)
            ]
            result = render_sample_events(events, bank, output, sample_rate=22050)

            with wave.open(str(output), "rb") as wav:
                pcm = array.array("h")
                pcm.frombytes(wav.readframes(wav.getnframes()))
            measured_peak = max(abs(value) for value in pcm)

            self.assertGreater(result["peak_before_normalization"], MAX_PEAK)
            self.assertLess(result["normalization_applied"], 1.0)
            self.assertLessEqual(measured_peak, round(32767 * MAX_PEAK) + 1)
            self.assertGreater(measured_peak, 0)
            self.assertEqual(result["clipping_samples"], 0)
            self.assertAlmostEqual(
                result["peak_after_normalization"], measured_peak / 32768.0, places=5
            )

    def test_mix_never_amplifies_quiet_audio_during_peak_management(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            output = Path(folder) / "quiet_mix.wav"
            result = render_sample_events([
                {"instrument": "piano", "midi_note": 60, "start_seconds": 0,
                 "duration_seconds": 0.08, "velocity": 20},
            ], bank, output, sample_rate=22050)

            self.assertLess(result["peak_before_normalization"], 0.92)
            self.assertEqual(result["normalization_applied"], 1.0)
            self.assertEqual(result["clipping_samples"], 0)
            self.assertLessEqual(result["peak_after_normalization"], 0.92)

    def test_composition_plan_becomes_sample_events(self):
        plan = compose_plan("برگرد ای عشق\nدلم گرفته از این شب سرد", target_bpm=84)
        events = build_composition_events(plan)
        parts = {event["instrument"] for event in events}
        self.assertEqual(parts, {"piano", "electric_bass", "kick", "snare", "closed_hat", "open_hat"})
        self.assertGreater(len(events), len(plan["composition"]["melody"]))
        pans = {event.get("pan", 0.0) for event in events}
        self.assertIn(-0.22, pans)
        self.assertIn(0.22, pans)
        expanded = build_composition_events(plan, instruments={
            "guitar": "acoustic_guitar",
            "strings": "strings",
            "electric_guitar": "electric_guitar",
        })
        expanded_parts = {event["instrument"] for event in expanded}
        self.assertTrue({"acoustic_guitar", "strings", "electric_guitar"}.issubset(expanded_parts))
        self.assertGreater(len(expanded), len(events))

    def test_composition_events_apply_balanced_and_overridable_part_gains(self):
        plan = compose_plan("برگرد ای عشق\nدلم گرفته از این شب سرد", target_bpm=84)
        defaults = build_composition_events(plan)
        default_gains = {
            part: next(event["gain"] for event in defaults
                       if event["instrument"] == instrument)
            for part, instrument in (("melody", "piano"), ("bass", "electric_bass"),
                                     ("kick", "kick"), ("snare", "snare"),
                                     ("closed_hat", "closed_hat"))
        }
        self.assertEqual(default_gains["melody"], 1.0)
        self.assertLess(default_gains["closed_hat"], default_gains["snare"])
        self.assertLess(default_gains["snare"], default_gains["kick"])
        self.assertLess(default_gains["kick"], default_gains["melody"])

        custom = build_composition_events(
            plan, instruments={"melody": "lead"},
            mix_gains={"melody": 0.75, "closed_hat": 1.1}
        )
        self.assertTrue(all(event["gain"] == 0.75 for event in custom
                            if event["instrument"] == "lead"))
        self.assertTrue(all(event["gain"] == 1.1 for event in custom
                            if event["instrument"] == "closed_hat"))

    def test_sample_renderer_rejects_invalid_event_gain(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            with self.assertRaises(ValueError):
                render_sample_events([
                    {"instrument": "piano", "midi_note": 60,
                     "start_seconds": 0, "duration_seconds": 0.1, "gain": 2.1}
                ], bank, Path(folder) / "invalid_gain.wav")

    def test_full_plan_renders_with_a_recorded_sample_bank(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            for instrument, note in (("piano", 60), ("electric_bass", 48),
                                     ("kick", 36), ("snare", 38),
                                     ("closed_hat", 42), ("open_hat", 46)):
                self.make_wav(root / instrument / "sample.wav", frames=11025)
            (root / "bank.json").write_text(json.dumps({
                "format_version": 1,
                "samples": [
                    {"instrument": instrument, "midi_note": note,
                     "path": instrument + "/sample.wav"}
                    for instrument, note in (("piano", 60), ("electric_bass", 48),
                                              ("kick", 36), ("snare", 38),
                                              ("closed_hat", 42), ("open_hat", 46))
                ]
            }), encoding="utf-8")
            bank = load_sample_bank(root)
            plan = compose_plan("برگرد ای عشق\nدلم گرفته از این شب سرد", target_bpm=84)
            # This fixture intentionally contains sustain recordings only.
            for phrase in plan["composition"]["melody"]:
                for item in phrase["note_lyric_map"]:
                    item["articulation"] = "sustain"
            output = Path(folder) / "song.wav"
            result = render_composition_to_wav(plan, bank, output, sample_rate=22050)
            with wave.open(str(output), "rb") as wav:
                audio = wav.readframes(wav.getnframes())
                self.assertEqual(wav.getnchannels(), 2)
            self.assertTrue(any(audio))
            self.assertGreater(result["events_rendered"], 0)

    def test_chorus_adds_snare_pickup_fills_at_phrase_ends(self):
        import copy
        base = compose_plan("برگرد ای عشق\nدلم گرفته از این شب سرد", target_bpm=84)
        plans = {}
        for section in ("verse", "chorus"):
            plan = copy.deepcopy(base)
            for phrase in plan["composition"]["melody"]:
                phrase["section"] = section
            plans[section] = build_composition_events(plan)
        snare_counts = {
            section: sum(event["instrument"] == "snare" for event in events)
            for section, events in plans.items()
        }
        self.assertGreater(snare_counts["chorus"], snare_counts["verse"])

    def test_sample_renderer_uses_phrase_level_cadence_chord(self):
        plan = compose_plan("دلم گرفته\nبرگرد ای عشق", target_bpm=84)
        plan["composition"]["melody"][0]["chord"] = "F"
        events = build_composition_events(
            plan, instruments={"chords": "piano", "melody": "lead"})
        first_bar = [event for event in events
                     if event["instrument"] == "piano" and
                     event["start_seconds"] < 4 * 60 / 84]
        pitch_classes = {event["midi_note"] % 12 for event in first_bar}
        self.assertTrue({0, 5, 9}.issubset(pitch_classes))

    def test_sample_arrangement_plays_all_dominant_seventh_chord_tones(self):
        plan = compose_plan("دلم گرفته\nبرگرد ای عشق", target_bpm=84)
        plan["composition"]["melody"][0]["chord"] = "G7"
        events = build_composition_events(
            plan, instruments={"chords": "keys", "melody": "lead"})
        first_bar = [event for event in events
                     if event["instrument"] == "keys" and
                     event["start_seconds"] < 4 * 60 / 84]
        self.assertEqual({event["midi_note"] % 12 for event in first_bar},
                         {7, 11, 2, 5})

    def test_sample_piano_pattern_changes_by_section(self):
        import copy
        base = compose_plan("برگرد ای عشق\nدلم گرفته از این شب سرد", target_bpm=84)
        counts = {}
        starts = {}
        for section in ("verse", "pre_chorus", "chorus", "bridge"):
            plan = copy.deepcopy(base)
            for phrase in plan["composition"]["melody"]:
                phrase["section"] = section
            events = build_composition_events(
                plan, instruments={"chords": "keys", "melody": "lead"})
            keys = [event for event in events if event["instrument"] == "keys"]
            first_bar = [event for event in keys
                         if event["start_seconds"] < 4 * 60 / 84]
            counts[section] = len(first_bar)
            starts[section] = [event["start_seconds"] for event in first_bar]
        self.assertEqual(counts["verse"], 8)
        self.assertEqual(counts["pre_chorus"], 4)
        self.assertEqual(counts["chorus"], 6)
        self.assertEqual(counts["bridge"], 3)
        self.assertEqual(starts["verse"], sorted(starts["verse"]))
        self.assertEqual(starts["bridge"], [0.0, 0.0, 0.0])

    def test_sample_transition_lift_is_bounded_and_spares_melody(self):
        import copy
        lyrics = "\n".join([
            "دلم گرفته از این شب", "صدای باران می‌آید",
            "برگرد به خانه", "هنوز چشم به راهت",
            "دوباره برگرد ای عشق", "چراغ خانه روشن است",
            "بهار از راه رسیده", "امید در دل ماست",
        ])
        plan = compose_plan(lyrics, target_bpm=84)
        phrases = plan["composition"]["melody"]
        target_index = next(
            index for index, phrase in enumerate(phrases)
            if phrase["phrase_energy"].get("section_transition")
            and phrase["phrase_energy"]["section_transition"]["next_section"]
        )
        lifted = copy.deepcopy(plan)
        neutral = copy.deepcopy(plan)
        lifted["composition"]["melody"][target_index]["phrase_energy"]["section_transition"]["energy_change"] = 1.0
        neutral["composition"]["melody"][target_index]["phrase_energy"]["section_transition"]["energy_change"] = 0.0
        lifted_events = build_composition_events(lifted)
        neutral_events = build_composition_events(neutral)
        phrase = phrases[target_index]
        start_tick = sum(
            item["bar_count"] * 4 * 480 + item.get("phrase_pause_ticks", 0)
            for item in phrases[:target_index]
        )
        transition_start = start_tick + (phrase["bar_count"] - 1) * 4 * 480
        transition_end = start_tick + phrase["bar_count"] * 4 * 480
        start_seconds = transition_start * 60.0 / 84 / 480
        end_seconds = transition_end * 60.0 / 84 / 480

        def select(events, predicate):
            return [(event["instrument"], event["midi_note"], event["start_seconds"],
                     event["duration_seconds"], event["velocity"], event["pan"])
                    for event in events if predicate(event)]

        before_transition = lambda event: event["start_seconds"] < start_seconds
        self.assertEqual(select(lifted_events, before_transition),
                         select(neutral_events, before_transition))

        def transition_values(events, instrument):
            return [event["velocity"] for event in events
                    if event["instrument"] == instrument
                    and start_seconds <= event["start_seconds"] < end_seconds]

        for instrument in ("electric_bass", "kick", "snare", "closed_hat",
                           "open_hat"):
            lifted_values = transition_values(lifted_events, instrument)
            neutral_values = transition_values(neutral_events, instrument)
            if lifted_values and neutral_values:
                self.assertGreater(max(lifted_values), max(neutral_values))

    def test_sample_guitar_alternates_downstroke_and_upstroke(self):
        plan = compose_plan("برگرد ای عشق\nدلم گرفته از این شب سرد", target_bpm=84)
        for phrase in plan["composition"]["melody"]:
            phrase["section"] = "verse"
        events = build_composition_events(
            plan, instruments={"guitar": "acoustic_guitar"})
        guitar = [event for event in events
                  if event["instrument"] == "acoustic_guitar"]
        self.assertGreaterEqual(len(guitar), 12)
        downstroke = guitar[:3]
        upstroke = guitar[3:6]
        self.assertEqual([e["midi_note"] for e in downstroke],
                         sorted(e["midi_note"] for e in downstroke))
        self.assertEqual([e["midi_note"] for e in upstroke],
                         sorted((e["midi_note"] for e in upstroke), reverse=True))
        self.assertGreater(sum(e["velocity"] for e in downstroke),
                           sum(e["velocity"] for e in upstroke))
        self.assertTrue(all(1 <= e["velocity"] <= 127 for e in guitar))

    def test_sample_melody_accents_peak_and_cadence_notes(self):
        plan = compose_plan("برگرد ای عشق\nدلم گرفته از این شب سرد", target_bpm=84)
        phrase = plan["composition"]["melody"][0]
        phrase["peak_note_index"] = 0
        events = build_composition_events(plan, instruments={"melody": "lead"})
        melody_events = [event for event in events if event["instrument"] == "lead"]
        self.assertEqual(len(melody_events), sum(
            len(item["midi_notes"]) for item in plan["composition"]["melody"]))
        self.assertGreater(melody_events[0]["velocity"], melody_events[1]["velocity"])
        self.assertGreater(melody_events[-1]["velocity"], 0)
        self.assertTrue(all(1 <= event["velocity"] <= 127 for event in melody_events))

    def test_sample_bass_follows_major_and_minor_chord_thirds(self):
        major = compose_plan("دلم گرفته\nبرگرد ای عشق", target_bpm=84)
        minor = compose_plan("دلم گرفته\nبرگرد ای عشق", target_bpm=84)
        major["composition"]["melody"][0]["chord"] = "A"
        minor["composition"]["melody"][0]["chord"] = "Am"
        major_events = build_composition_events(
            major, instruments={"bass": "bass", "melody": "lead"})
        minor_events = build_composition_events(
            minor, instruments={"bass": "bass", "melody": "lead"})
        major_bass = [e for e in major_events if e["instrument"] == "bass"]
        minor_bass = [e for e in minor_events if e["instrument"] == "bass"]
        major_third = next(e for e in major_bass
                           if abs(e["start_seconds"] - (2 * 60 / 84)) < 0.001)
        minor_third = next(e for e in minor_bass
                           if abs(e["start_seconds"] - (2 * 60 / 84)) < 0.001)
        self.assertEqual(major_third["midi_note"] % 12, (45 + 4) % 12)
        self.assertEqual(minor_third["midi_note"] % 12, (45 + 3) % 12)

    def test_sample_seventh_chords_support_four_voice_panning(self):
        import copy
        base = compose_plan("برگرد ای عشق\nدلم گرفته از این شب سرد", target_bpm=84)
        for section in ("pre_chorus", "chorus"):
            plan = copy.deepcopy(base)
            plan["composition"]["melody"][0]["section"] = section
            plan["composition"]["melody"][0]["chord"] = "G7"
            events = build_composition_events(
                plan, instruments={"chords": "chord_bank", "melody": "lead"})
            chord_events = [event for event in events
                            if event["instrument"] == "chord_bank"]
            self.assertTrue(chord_events)
            self.assertTrue(all(-0.24 <= event["pan"] <= 0.24
                                for event in chord_events))

    def test_descriptive_final_chorus_label_uses_final_arrangement_profile(self):
        self.assertEqual(_section_kind("verse_2_and_final_chorus"), "final_chorus")
        self.assertEqual(_section_kind("pre-chorus"), "pre_chorus")
        self.assertEqual(_section_kind("verse_2"), "verse")

    def test_vocal_space_ducks_harmonic_layers_but_preserves_lead_and_rhythm(self):
        plan = compose_plan("برگرد ای عشق\\nدلم گرفته از این شب سرد", target_bpm=84)
        events = build_composition_events(
            plan, instruments={"melody": "lead", "chords": "keys"})
        lead = next(event for event in events if event["instrument"] == "lead")
        chord = next(event for event in events if event["instrument"] == "keys")
        bass = next(event for event in events if event["instrument"] == "electric_bass")
        self.assertEqual(lead["vocal_space_mode"], "unaffected")
        self.assertEqual(lead["vocal_space_gain"], 1.0)
        self.assertEqual(chord["vocal_space_mode"], "support_under_vocal")
        self.assertLess(chord["vocal_space_gain"], 1.0)
        self.assertEqual(chord["vocal_space_planner"], "deterministic_vocal_space_v1")
        self.assertEqual(bass["vocal_space_gain"], 1.0)

    def test_arrangement_events_include_part_expression_metadata(self):
        plan = compose_plan("دلم گرفته از این شب\\nبرگرد به خانه")
        events = build_composition_events(plan)
        melody = next(event for event in events if event["expression_profile"].endswith("_melody_stereo_v1"))
        hats = [event for event in events if event["instrument"] == "closed_hat"]
        self.assertEqual(melody["pan"], 0.0)
        self.assertEqual(melody["expression_planner"], "deterministic_part_expression_v1")
        self.assertTrue(hats)
        self.assertEqual(hats[0]["pan"], -0.14)
        self.assertEqual(hats[1]["pan"], 0.14)

    def test_sample_arrangement_dynamics_change_by_section(self):
        import copy
        base = compose_plan("برگرد ای عشق\nدلم گرفته از این شب سرد", target_bpm=84)
        verse = copy.deepcopy(base)
        final_chorus = copy.deepcopy(base)
        bridge = copy.deepcopy(base)
        for plan, section in ((verse, "verse"), (final_chorus, "final_chorus"),
                              (bridge, "bridge")):
            for phrase in plan["composition"]["melody"]:
                phrase["section"] = section
        verse_events = build_composition_events(verse)
        chorus_events = build_composition_events(final_chorus)
        bridge_events = build_composition_events(bridge)
        average = lambda events, part: sum(e["velocity"] for e in events
                                           if e["instrument"] == part) / sum(
                                               1 for e in events if e["instrument"] == part)
        self.assertGreater(average(chorus_events, "piano"),
                           average(verse_events, "piano"))
        self.assertGreater(average(chorus_events, "electric_bass"),
                           average(verse_events, "electric_bass"))
        self.assertGreater(average(chorus_events, "kick"),
                           average(verse_events, "kick"))
        bridge_hat_count = sum(e["instrument"] == "closed_hat" for e in bridge_events)
        verse_hat_count = sum(e["instrument"] == "closed_hat" for e in verse_events)
        self.assertLess(bridge_hat_count, verse_hat_count)

    def test_phrase_pause_is_preserved_between_rendered_lyric_lines(self):
        plan = compose_plan("برگرد ای عشق\nدلم گرفته از این شب سرد", target_bpm=84)
        phrases = plan["composition"]["melody"]
        self.assertGreaterEqual(len(phrases), 2)
        phrases[0]["phrase_pause_ticks"] = 240
        events = build_composition_events(plan)
        boundary = (phrases[0]["bar_count"] * 4 * 480) * (60.0 / 84 / 480)
        second_phrase_events = [
            event for event in events
            if event["start_seconds"] >= boundary
        ]
        self.assertTrue(second_phrase_events)
        earliest = min(event["start_seconds"] for event in second_phrase_events)
        self.assertAlmostEqual(earliest, boundary + 240 * (60.0 / 84 / 480), places=5)

    def test_rejects_invalid_phrase_pause(self):
        plan = compose_plan("برگرد ای عشق\nدلم گرفته از این شب سرد", target_bpm=84)
        plan["composition"]["melody"][0]["phrase_pause_ticks"] = True
        with self.assertRaises(ValueError):
            build_composition_events(plan)

    def test_looped_sample_sustains_past_original_recording_length(self):
        import struct
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            self.make_wav(root / "piano" / "loop.wav", frames=2205)
            (root / "bank.json").write_text(json.dumps({
                "format_version": 1,
                "samples": [{
                    "instrument": "piano", "midi_note": 60,
                    "path": "piano/loop.wav",
                    "loop_start_frame": 200, "loop_end_frame": 2000
                }]
            }), encoding="utf-8")
            bank = load_sample_bank(root)
            output = Path(folder) / "sustain.wav"
            render_sample_events([
                {"instrument": "piano", "midi_note": 60, "start_seconds": 0,
                 "duration_seconds": 0.35, "velocity": 90}
            ], bank, output, sample_rate=22050)
            with wave.open(str(output), "rb") as wav:
                self.assertEqual(wav.getnframes(), math.ceil(0.35 * 22050))
                raw = wav.readframes(wav.getnframes())
            samples = struct.unpack("<" + "h" * (len(raw) // 2), raw)
            self.assertTrue(any(samples[5000:]))

    def test_rejects_missing_instrument_before_creating_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            output = Path(folder) / "never.wav"
            with self.assertRaises(ValueError):
                render_sample_events([
                    {"instrument": "violin", "midi_note": 60,
                     "start_seconds": 0, "duration_seconds": 0.1}
                ], bank, output)
            self.assertFalse(output.exists())

    def test_rejects_excessive_duration(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            with self.assertRaises(ValueError):
                render_sample_events([
                    {"instrument": "piano", "midi_note": 60,
                     "start_seconds": 119.9, "duration_seconds": 1}
                ], bank, Path(folder) / "too_long.wav")

    def test_pan_places_mono_sample_on_requested_side(self):
        import struct
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            output = Path(folder) / "left.wav"
            render_sample_events([
                {"instrument": "piano", "midi_note": 60, "start_seconds": 0,
                 "duration_seconds": 0.08, "velocity": 100, "pan": -1.0}
            ], bank, output, sample_rate=22050)
            with wave.open(str(output), "rb") as wav:
                samples = struct.unpack("<" + "h" * (len(raw := wav.readframes(wav.getnframes())) // 2), raw)
            left = sum(abs(samples[i]) for i in range(0, len(samples), 2))
            right = sum(abs(samples[i]) for i in range(1, len(samples), 2))
            self.assertGreater(left, 0)
            self.assertEqual(right, 0)

    def test_rejects_invalid_velocity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            with self.assertRaises(ValueError):
                render_sample_events([
                    {"instrument": "piano", "midi_note": 60,
                     "start_seconds": 0, "duration_seconds": 0.1,
                     "velocity": 0}
                ], bank, Path(folder) / "bad.wav")



    def test_composition_events_carry_planned_melody_articulation(self):
        plan = compose_plan("دلم گرفته\\nبرگرد ای عشق", target_bpm=84)
        phrase = plan["composition"]["melody"][0]
        phrase["note_lyric_map"][0]["articulation"] = "staccato"
        events = build_composition_events(plan)
        melody_event = next(event for event in events if event["instrument"] == "piano")
        self.assertEqual(melody_event["articulation"], "staccato")
        self.assertEqual(melody_event["articulation_source"], "planner")

    def test_missing_exact_articulation_sample_is_blocked_without_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            output = Path(folder) / "blocked.wav"
            with self.assertRaisesRegex(ValueError, "planner_selected=pizzicato"):
                render_sample_events([
                    {"instrument": "piano", "midi_note": 60, "start_seconds": 0,
                     "duration_seconds": 0.08, "articulation": "pizzicato",
                     "articulation_source": "planner"}
                ], bank, output)
            self.assertFalse(output.exists())

    def test_legacy_event_defaults_to_sustain_and_reports_render_status(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            output = Path(folder) / "legacy.wav"
            result = render_sample_events([
                {"instrument": "piano", "midi_note": 60, "start_seconds": 0,
                 "duration_seconds": 0.08}
            ], bank, output, sample_rate=22050)
            self.assertEqual(result["articulations_rendered"], ["sustain"])
            self.assertEqual(result["articulation_diagnostics"]["legacy_defaulted"], ["sustain"])
            self.assertTrue(result["articulation_diagnostics"]["renderer_supports_exact_match"])
            self.assertTrue(result["articulation_diagnostics"]["sample_exact_match"])
            self.assertTrue(result["articulation_diagnostics"]["audio_rendered"])


    def test_planned_articulation_controls_sample_gate_and_release(self):
        plan = compose_plan("دلم گرفته\\nبرگرد ای عشق", target_bpm=84)
        item = plan["composition"]["melody"][0]["note_lyric_map"][0]
        item.update({"articulation": "staccato", "gate_ratio": 0.62, "release_ms": 12})
        event = next(event for event in build_composition_events(plan)
                     if event["instrument"] == "piano")
        ticks = int(plan["composition"]["melody"][0]["note_durations_ticks"][0] * 0.62)
        self.assertEqual(event["duration_seconds"], round(ticks * 60 / 84 / 480, 6))
        self.assertEqual(event["release_seconds"], 0.012)

    def test_composition_events_use_planned_per_note_dynamics_velocity(self):
        plan = compose_plan("دلم گرفته\\nبرگرد ای عشق", target_bpm=84)
        item = plan["composition"]["melody"][0]["note_lyric_map"][0]
        item["dynamics_velocity"] = 112
        event = next(event for event in build_composition_events(plan)
                     if event["instrument"] == "piano")
        self.assertGreater(event["velocity"], 84)
        self.assertLessEqual(event["velocity"], 127)

    def test_release_seconds_is_validated_and_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            output = Path(folder) / "release.wav"
            with self.assertRaisesRegex(ValueError, "release_seconds"):
                render_sample_events([
                    {"instrument": "piano", "midi_note": 60, "start_seconds": 0,
                     "duration_seconds": 0.08, "release_seconds": 1.1}
                ], bank, output)
            result = render_sample_events([
                {"instrument": "piano", "midi_note": 60, "start_seconds": 0,
                 "duration_seconds": 0.08, "release_seconds": 0.012}
            ], bank, output, sample_rate=22050)
            self.assertTrue(result["articulation_diagnostics"]["performance_shaping_applied"])
            self.assertEqual(result["articulation_diagnostics"]["release_profiles_ms"], [12])


    def test_guitar_melodic_fill_uses_only_written_vocal_rest(self):
        plan = compose_plan("برگرد ای عشق،\\nدلم گرفته از این شب سرد.", target_bpm=84)
        events = build_composition_events(
            plan, instruments={"guitar": "acoustic_guitar"}
        )
        fills = [event for event in events
                 if event.get("event_role") == "melodic_response_fill"]
        self.assertTrue(fills)
        first_phrase = plan["composition"]["melody"][0]
        gap_start_tick = first_phrase["bar_count"] * 4 * 480
        seconds_per_tick = 60 / 84 / 480
        self.assertEqual(fills[0]["start_seconds"],
                         round(gap_start_tick * seconds_per_tick, 6))
        self.assertLessEqual(
            fills[0]["duration_seconds"],
            round(first_phrase["phrase_pause_ticks"] * seconds_per_tick, 6),
        )
        self.assertEqual(fills[0]["fill_planner"], "instrument_shaped_melodic_fill_v2")
        self.assertEqual(fills[0]["velocity"], 54)
        self.assertEqual(fills[0]["articulation"], "fingerstyle")
        self.assertFalse(any(event.get("event_role") == "melodic_response_fill"
                             for event in build_composition_events(plan)))

    def test_persian_instrument_response_fills_use_their_recorded_techniques(self):
        plan = compose_plan("برگرد ای عشق،\\nدلم گرفته از این شب سرد.", target_bpm=84)
        plan["composition"]["melody"][0]["section"] = "chorus"
        cases = {
            "tar": {"mezrab_down", "mezrab_up"},
            "setar": {"mezrab_down", "mezrab_up"},
            "santur": {"soft_mallet", "hard_mallet", "roll"},
            "kamancheh": {"short_bow", "long_bow"},
        }
        for slug, expected in cases.items():
            with self.subTest(instrument=slug):
                events = build_composition_events(
                    plan, instruments={"guitar": slug}, response_fill_part="guitar"
                )
                fills = [e for e in events if e.get("event_role") == "melodic_response_fill"]
                self.assertTrue(fills)
                self.assertTrue({e["articulation"] for e in fills} <= expected)
                self.assertTrue(all(e["instrument"] == slug for e in fills))
        self.assertFalse(any(
            e.get("event_role") == "melodic_response_fill"
            for e in build_composition_events(plan, response_fill_part="guitar")
        ))

    def test_response_fill_can_use_explicit_piano_or_strings_part(self):
        plan = compose_plan("برگرد ای عشق،\\nدلم گرفته از این شب سرد.", target_bpm=84)
        plan["composition"]["melody"][0]["section"] = "chorus"
        piano = build_composition_events(plan, response_fill_part="melody")
        piano_fills = [e for e in piano if e.get("event_role") == "melodic_response_fill"]
        self.assertTrue(piano_fills)
        self.assertEqual({e["articulation"] for e in piano_fills}, {"staccato"})
        strings = build_composition_events(
            plan, instruments={"strings": "strings"}, response_fill_part="strings"
        )
        string_fills = [e for e in strings if e.get("event_role") == "melodic_response_fill"]
        self.assertTrue(string_fills)
        self.assertEqual({e["articulation"] for e in string_fills}, {"sustain"})
        self.assertLessEqual(len(string_fills), 2)
        self.assertFalse(any(e.get("event_role") == "melodic_response_fill"
                             for e in build_composition_events(
                                 plan, response_fill_part="strings"
                             )))


    def test_persian_dastgah_profile_controls_response_fill_and_metadata(self):
        plan = compose_plan("برگرد ای عشق،\\nدلم گرفته از این شب سرد.", target_bpm=84,
                            persian_dastgah="shur")
        plan["composition"]["melody"][0]["section"] = "chorus"
        plan["composition"]["key"] = "D"
        events = build_composition_events(
            plan, instruments={"guitar": "tar"}, response_fill_part="guitar"
        )
        fills = [e for e in events if e.get("event_role") == "melodic_response_fill"]
        self.assertTrue(fills)
        self.assertTrue(all(e["modal_profile"] == "shur" for e in fills))
        self.assertTrue(all(e["modal_tuning"] == "12tet_approximation" for e in fills))
        self.assertTrue(all(e["microtonal_audio_rendered"] is False for e in fills))
        self.assertEqual(fills[-1]["midi_note"] % 12, 2)


    def test_sample_renderer_applies_cents_offset_to_recorded_sample(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            output = Path(folder) / "detuned.wav"
            result = render_sample_events([{
                "instrument": "piano", "midi_note": 60, "pitch_cents": 50,
                "start_seconds": 0, "duration_seconds": 0.05, "velocity": 90,
            }], bank, output, sample_rate=22050)
            self.assertEqual(result["events_rendered"], 1)
            self.assertTrue(output.exists())

    def test_sample_renderer_rejects_pitch_cents_outside_range(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            with self.assertRaisesRegex(ValueError, "pitch_cents"):
                render_sample_events([{
                    "instrument": "piano", "midi_note": 60, "pitch_cents": 201,
                    "start_seconds": 0, "duration_seconds": 0.05, "velocity": 90,
                }], bank, Path(folder) / "invalid.wav", sample_rate=22050)

    def test_composition_pitch_cents_reaches_sample_event(self):
        plan = compose_plan("یک شب آرام\\nدر این سکوت")
        plan["composition"]["melody"][0]["note_lyric_map"][0]["pitch_cents"] = -50
        events = build_composition_events(plan)
        first_melody = next(event for event in events if event["instrument"] == "piano")
        self.assertEqual(first_melody["pitch_cents"], -50.0)


    def test_custom_persian_degree_cents_reach_sampled_melody(self):
        plan = compose_plan(
            "دلم گرفته از این شب\\nبرگرد به خانه",
            persian_dastgah="shur",
            persian_degree_cents={1: 50, 4: -50},
        )
        events = build_composition_events(plan)
        melody_events = [event for event in events
                         if event["instrument"] == "piano" and event["pitch_cents"]]
        self.assertTrue(melody_events)
        self.assertTrue(all(abs(event["pitch_cents"]) == 50.0
                            for event in melody_events))


    def test_custom_degree_cents_are_applied_to_response_fill_events(self):
        plan = compose_plan(
            "دلم گرفته از این شب\\nبرگرد به خانه",
            persian_dastgah="shur",
            persian_degree_cents={0: 50, 1: 50, 2: 50, 3: 50, 4: 50, 5: 50, 6: 50},
        )
        plan["composition"]["melody"][0]["section"] = "chorus"
        plan["composition"]["melody"][0]["phrase_pause_ticks"] = 360
        events = build_composition_events(
            plan, instruments={"guitar": "tar"}, response_fill_part="guitar"
        )
        fills = [event for event in events
                 if event.get("event_role") == "melodic_response_fill"]
        self.assertTrue(fills)
        self.assertTrue(any(event["pitch_cents"] != 0.0 for event in fills))


    def test_recorded_sample_renderer_actually_applies_modal_pitch_offset(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            bank = self.make_bank(root)
            plain_path = Path(folder) / "plain.wav"
            tuned_path = Path(folder) / "tuned.wav"
            common = {
                "instrument": "piano", "midi_note": 60,
                "start_seconds": 0, "duration_seconds": 0.08,
                "velocity": 90,
            }
            plain = render_sample_events(
                [{**common, "pitch_cents": 0.0}], bank, plain_path,
                sample_rate=22050,
            )
            tuned = render_sample_events(
                [{**common, "pitch_cents": 50.0}], bank, tuned_path,
                sample_rate=22050,
            )
            self.assertEqual(plain["pitch_cents_applied_events"], 0)
            self.assertFalse(plain["microtonal_pitch_offsets_rendered"])
            self.assertEqual(tuned["pitch_cents_applied_events"], 1)
            self.assertTrue(tuned["microtonal_pitch_offsets_rendered"])
            self.assertNotEqual(plain_path.read_bytes(), tuned_path.read_bytes())


    def test_instrument_specific_note_tuning_reaches_sample_events(self):
        plan = compose_plan("یک شب آرام\\nدر این سکوت")
        first_note = plan["composition"]["melody"][0]["midi_notes"][0]
        events = build_composition_events(
            plan, instrument_tuning_cents={"piano": {first_note: 37.5}}
        )
        first_melody = next(
            event for event in events
            if event["instrument"] == "piano" and event["midi_note"] == first_note
        )
        self.assertEqual(first_melody["instrument_tuning_offset_cents"], 37.5)
        self.assertEqual(first_melody["pitch_cents"], 37.5)

    def test_instrument_specific_note_tuning_rejects_invalid_offsets(self):
        plan = compose_plan("یک شب آرام\\nدر این سکوت")
        with self.assertRaisesRegex(ValueError, "instrument tuning offsets"):
            build_composition_events(plan, instrument_tuning_cents={"tar": {60: 150.0}})

    def test_modal_and_instrument_tuning_offsets_are_combined(self):
        plan = compose_plan(
            "دلم گرفته از این شب\\nبرگرد به خانه",
            persian_dastgah="shur",
            persian_degree_cents={0: 25, 1: 25, 2: 25, 3: 25, 4: 25, 5: 25, 6: 25},
        )
        first_note = plan["composition"]["melody"][0]["midi_notes"][0]
        events = build_composition_events(
            plan, instrument_tuning_cents={"piano": {first_note: -12.5}}
        )
        first_melody = next(
            event for event in events
            if event["instrument"] == "piano" and event["midi_note"] == first_note
        )
        self.assertEqual(first_melody["instrument_tuning_offset_cents"], -12.5)
        self.assertEqual(first_melody["pitch_cents"], 12.5)


    def test_renderer_prefers_quality_ranked_exact_note_over_nearer_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            self.make_wav(root / "piano" / "exact_clean.wav", frames=2205)
            self.make_wav(root / "piano" / "nearby.wav", frames=2205)
            clipped_path = root / "piano" / "exact_clipped.wav"
            clipped_path.parent.mkdir(parents=True, exist_ok=True)
            with wave.open(str(clipped_path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(22050)
                wav.writeframes(struct.pack("<" + "h" * 2205, *([32767] * 2205)))
            (root / "bank.json").write_text(json.dumps({
                "format_version": 1,
                "samples": [
                    {"instrument": "piano", "midi_note": 60,
                     "path": "piano/exact_clean.wav",
                     "velocity_min": 1, "velocity_max": 100},
                    {"instrument": "piano", "midi_note": 60,
                     "path": "piano/exact_clipped.wav",
                     "velocity_min": 50, "velocity_max": 127},
                    {"instrument": "piano", "midi_note": 61,
                     "path": "piano/nearby.wav"},
                ],
            }), encoding="utf-8")
            bank = load_sample_bank(root)
            result = render_sample_events([{
                "instrument": "piano", "midi_note": 60,
                "start_seconds": 0, "duration_seconds": 0.05,
                "velocity": 80,
            }], bank, Path(folder) / "ranked.wav", sample_rate=22050)
            self.assertEqual(
                result["sample_selection"]["exact_note_quality_ranked_events"], 1
            )
            self.assertEqual(
                result["sample_selection"]["pitch_shifted_nearest_note_events"], 0
            )


if __name__ == "__main__":
    unittest.main()
