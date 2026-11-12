import json
import math
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank import load_sample_bank
from sample_renderer import build_composition_events, render_composition_to_wav, render_sample_events
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


if __name__ == "__main__":
    unittest.main()
