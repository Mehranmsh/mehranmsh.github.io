import json
import math
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank_preview import render_one_note


class SampleBankPreviewTests(unittest.TestCase):
    def make_bank(self, root: Path) -> None:
        sample_path = root / "piano" / "sustain" / "a4.wav"
        sample_path.parent.mkdir(parents=True)
        frames = bytearray()
        for index in range(4410):
            value = int(9000 * math.sin(2 * math.pi * 440 * index / 44100))
            frames.extend(value.to_bytes(2, "little", signed=True))
        with wave.open(str(sample_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(44100)
            wav.writeframes(bytes(frames))
        (root / "bank.json").write_text(json.dumps({
            "format_version": 1,
            "samples": [{
                "instrument": "piano", "midi_note": 69,
                "velocity_min": 1, "velocity_max": 127,
                "articulation": "sustain", "path": "piano/sustain/a4.wav",
            }],
        }), encoding="utf-8")

    def test_renders_one_exact_recorded_note_to_non_silent_wav(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            self.make_bank(root)
            output = Path(folder) / "preview.wav"
            report = render_one_note(root, "piano", 69, 90, "sustain", output)
            self.assertTrue(report["rendered"])
            self.assertEqual(report["source"], "recorded_sample_bank")
            self.assertEqual(report["selected_sample"], "piano/sustain/a4.wav")
            with wave.open(str(output), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 2)
                self.assertGreater(wav.getnframes(), 0)
                pcm = wav.readframes(wav.getnframes())
            self.assertTrue(any(pcm))

    def test_refuses_nearest_note_when_exact_note_is_missing(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            self.make_bank(root)
            with self.assertRaisesRegex(ValueError, "Exact recorded note unavailable"):
                render_one_note(root, "piano", 70, 90, "sustain", Path(folder) / "missing.wav")


if __name__ == "__main__":
    unittest.main()
