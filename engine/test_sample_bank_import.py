import csv
import json
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank_import import build_sample_bank_manifest


class SampleBankImportTests(unittest.TestCase):
    def write_wav(self, path, frames=512):
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(44100)
            wav.writeframes(b"\\x10\\x00" * frames)

    def write_csv(self, path, rows):
        fields = [
            "instrument", "midi_note", "velocity_min", "velocity_max",
            "articulation", "recording_status", "recorded_file_path",
        ]
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)

    def test_import_builds_manifest_from_completed_rows_only(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "audio"
            root.mkdir()
            self.write_wav(root / "piano" / "sustain" / "a4.wav")
            sheet = Path(folder) / "capture.csv"
            self.write_csv(sheet, [
                {
                    "instrument": "piano", "midi_note": "69",
                    "velocity_min": "1", "velocity_max": "127",
                    "articulation": "sustain", "recording_status": "recorded",
                    "recorded_file_path": "piano/sustain/a4.wav",
                },
                {
                    "instrument": "piano", "midi_note": "70",
                    "velocity_min": "1", "velocity_max": "127",
                    "articulation": "sustain", "recording_status": "planned",
                    "recorded_file_path": "",
                },
            ])
            report = build_sample_bank_manifest(sheet, root)
            manifest = json.loads((root / "bank.json").read_text(encoding="utf-8"))
            self.assertTrue(report["validated"])
            self.assertEqual(report["imported_samples"], 1)
            self.assertEqual(report["skipped_rows"], 1)
            self.assertEqual(manifest["samples"][0]["midi_note"], 69)
            self.assertEqual(manifest["samples"][0]["path"], "piano/sustain/a4.wav")

    def test_invalid_audio_does_not_replace_existing_manifest(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "audio"
            root.mkdir()
            (root / "bank.json").write_text('{"format_version":1,"samples":[]}', encoding="utf-8")
            original = (root / "bank.json").read_bytes()
            (root / "piano").mkdir()
            (root / "piano" / "bad.wav").write_bytes(b"not a wav")
            sheet = Path(folder) / "capture.csv"
            self.write_csv(sheet, [{
                "instrument": "piano", "midi_note": "60",
                "velocity_min": "1", "velocity_max": "127",
                "articulation": "sustain", "recording_status": "recorded",
                "recorded_file_path": "piano/bad.wav",
            }])
            with self.assertRaises(ValueError):
                build_sample_bank_manifest(sheet, root)
            self.assertEqual((root / "bank.json").read_bytes(), original)

    def test_import_rejects_audio_paths_outside_bank_root(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "audio"
            root.mkdir()
            outside = Path(folder) / "outside.wav"
            self.write_wav(outside)
            sheet = Path(folder) / "capture.csv"
            self.write_csv(sheet, [{
                "instrument": "piano", "midi_note": "60",
                "velocity_min": "1", "velocity_max": "127",
                "articulation": "sustain", "recording_status": "recorded",
                "recorded_file_path": "../outside.wav",
            }])
            with self.assertRaises(ValueError):
                build_sample_bank_manifest(sheet, root)


if __name__ == "__main__":
    unittest.main()
