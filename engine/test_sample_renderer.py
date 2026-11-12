import json
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank import load_sample_bank
from sample_renderer import render_sample_events


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
