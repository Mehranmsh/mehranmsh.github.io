import json
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
        self.make_wav(root / "bass" / "c3.wav", channels=2)
        (root / "bank.json").write_text(json.dumps({
            "format_version": 1,
            "samples": [
                {"instrument": "piano", "midi_note": 60, "path": "piano/c4.wav"},
                {"instrument": "bass", "midi_note": 48, "path": "bass/c3.wav"}
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
                {"instrument": "bass", "midi_note": 48, "start_seconds": 0.02,
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
        self.assertEqual(parts, {"piano", "bass", "drums"})
        self.assertGreater(len(events), len(plan["composition"]["melody"]))
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
            for instrument, note in (("piano", 60), ("bass", 48), ("drums", 42)):
                self.make_wav(root / instrument / "sample.wav", frames=11025)
            (root / "bank.json").write_text(json.dumps({
                "format_version": 1,
                "samples": [
                    {"instrument": instrument, "midi_note": note,
                     "path": instrument + "/sample.wav"}
                    for instrument, note in (("piano", 60), ("bass", 48), ("drums", 42))
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
