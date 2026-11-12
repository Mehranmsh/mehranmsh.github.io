import csv
import json
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank_tool import export_sample_bank_progress_csv, inspect_sample_bank


class SampleBankToolTests(unittest.TestCase):
    def write_sample(self, path, value=8000):
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(44100)
            wav.writeframes((value).to_bytes(2, "little", signed=True) * 256)

    def test_inspection_reports_missing_targets_without_mutating_bank(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sample = root / "piano" / "36_soft.wav"
            self.write_sample(sample)
            manifest = root / "bank.json"
            manifest.write_text(json.dumps({
                "format_version": 1,
                "samples": [{
                    "instrument": "piano", "midi_note": 36,
                    "velocity_min": 1, "velocity_max": 48,
                    "path": "piano/36_soft.wav",
                }],
            }), encoding="utf-8")
            before = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
            report = inspect_sample_bank(root)
            after = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
            self.assertTrue(report["read_only"])
            self.assertFalse(report["ready"])
            self.assertGreater(report["summary"]["missing_targets"], 0)
            self.assertEqual(report["recorded_samples"], 1)
            self.assertEqual(before, after)

    def test_progress_csv_marks_exact_recordings_and_missing_targets(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sample = root / "piano" / "36_sustain.wav"
            self.write_sample(sample)
            (root / "bank.json").write_text(json.dumps({
                "format_version": 1,
                "samples": [{
                    "instrument": "piano", "midi_note": 36,
                    "velocity_min": 1, "velocity_max": 127,
                    "articulation": "sustain",
                    "path": "piano/36_sustain.wav",
                }],
            }), encoding="utf-8")
            rows = list(csv.DictReader(
                export_sample_bank_progress_csv(root).splitlines()
            ))
            matching = [
                row for row in rows
                if row["instrument"] == "piano"
                and row["midi_note"] == "36"
                and row["articulation"] == "sustain"
            ]
            self.assertTrue(matching)
            self.assertTrue(all(row["status"] == "recorded" for row in matching))
            self.assertTrue(all(
                row["sample_path"] == "piano/36_sustain.wav" for row in matching
            ))
            absent = next(
                row for row in rows
                if row["instrument"] == "piano"
                and row["midi_note"] == "36"
                and row["articulation"] != "sustain"
            )
            self.assertEqual(absent["status"], "missing")
            self.assertEqual(absent["sample_path"], "")

    def test_inspection_rejects_missing_manifest(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                inspect_sample_bank(folder)


if __name__ == "__main__":
    unittest.main()
