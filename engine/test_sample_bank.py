import json
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank import load_sample_bank, select_sample


class SampleBankTests(unittest.TestCase):
    def write_sample(self, path, *, width=2, channels=1, rate=44100):
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(channels)
            wav.setsampwidth(width)
            wav.setframerate(rate)
            wav.writeframes(b"\\x00\\x00" * channels * 128)

    def write_manifest(self, root, samples):
        (root / "bank.json").write_text(
            json.dumps({"format_version": 1, "samples": samples}),
            encoding="utf-8",
        )

    def test_loads_recorded_wav_and_selects_nearest_pitch(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "piano" / "c4.wav")
            self.write_sample(root / "piano" / "g4.wav")
            self.write_manifest(root, [
                {"instrument": "piano", "midi_note": 60, "path": "piano/c4.wav"},
                {"instrument": "piano", "midi_note": 67, "path": "piano/g4.wav"},
            ])
            bank = load_sample_bank(root)
            selected = select_sample(bank, "piano", 65)
            self.assertEqual(selected.midi_note, 67)
            self.assertEqual(selected.sample_rate, 44100)
            self.assertEqual(selected.channels, 1)

    def test_velocity_layers_are_respected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "piano" / "soft.wav")
            self.write_sample(root / "piano" / "hard.wav")
            self.write_manifest(root, [
                {"instrument": "piano", "midi_note": 60, "path": "piano/soft.wav",
                 "velocity_min": 1, "velocity_max": 70},
                {"instrument": "piano", "midi_note": 60, "path": "piano/hard.wav",
                 "velocity_min": 71, "velocity_max": 127},
            ])
            bank = load_sample_bank(root)
            self.assertTrue(select_sample(bank, "piano", 60, 50).path.name == "soft.wav")
            self.assertTrue(select_sample(bank, "piano", 60, 100).path.name == "hard.wav")

    def test_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            self.write_manifest(root, [
                {"instrument": "piano", "midi_note": 60, "path": "../outside.wav"}
            ])
            with self.assertRaises(ValueError):
                load_sample_bank(root)

    def test_rejects_non_pcm16_sample(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "bad.wav", width=1)
            self.write_manifest(root, [
                {"instrument": "piano", "midi_note": 60, "path": "bad.wav"}
            ])
            with self.assertRaises(ValueError):
                load_sample_bank(root)

    def test_missing_instrument_sample_is_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "piano.wav")
            self.write_manifest(root, [
                {"instrument": "piano", "midi_note": 60, "path": "piano.wav"}
            ])
            bank = load_sample_bank(root)
            with self.assertRaises(ValueError):
                select_sample(bank, "violin", 60)


if __name__ == "__main__":
    unittest.main()
