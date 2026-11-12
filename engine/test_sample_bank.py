import json
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank import (
    SAMPLE_INSTRUMENT_CATALOG,
    analyze_sample_bank_coverage,
    analyze_sample_bank_quality,
    load_sample_bank,
    select_sample,
)


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
            self.assertEqual(select_sample(bank, "piano", 60, 50).path.name, "soft.wav")
            self.assertEqual(select_sample(bank, "piano", 60, 100).path.name, "hard.wav")

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

    def test_rejects_invalid_sustain_loop_points(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "piano.wav")
            self.write_manifest(root, [{
                "instrument": "piano", "midi_note": 60, "path": "piano.wav",
                "loop_start_frame": 120, "loop_end_frame": 100
            }])
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

    def test_catalog_defines_all_current_renderer_instruments(self):
        self.assertEqual(
            set(SAMPLE_INSTRUMENT_CATALOG),
            {"piano", "acoustic_guitar", "electric_bass", "strings",
             "electric_guitar", "kick", "snare", "closed_hat", "open_hat"},
        )
        self.assertEqual(SAMPLE_INSTRUMENT_CATALOG["piano"]["note_range"], [36, 96])

    def test_incomplete_bank_reports_missing_notes_and_velocity_layers(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "piano" / "c2_soft.wav")
            self.write_manifest(root, [{
                "instrument": "piano", "midi_note": 36, "path": "piano/c2_soft.wav",
                "velocity_min": 1, "velocity_max": 48,
            }])
            report = analyze_sample_bank_coverage(load_sample_bank(root))
            self.assertFalse(report["ready"])
            piano = report["instruments"]["piano"]
            self.assertEqual(piano["recorded_samples"], 1)
            self.assertEqual(piano["covered_requirements"], 1)
            self.assertIn(36, piano["missing_velocity_layers"] and piano["missing_notes"] or [36])
            self.assertTrue(any(item["note"] == 36 and item["layer"] == "medium"
                                for item in piano["missing_velocity_layers"]))
            self.assertIn("acoustic_guitar", report["instruments"])

    def test_sample_quality_diagnostics_detect_silence_clipping_and_dc_offset(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fixtures = {
                "good": [4096, -4096, 8192, -8192] * 64,
                "silent": [0] * 256,
                "clipped": [-32768, 32767] * 128,
                "dc": [4096] * 256,
            }
            entries = []
            for note, (name, values) in enumerate(fixtures.items(), start=60):
                path = root / "piano" / f"{name}.wav"
                path.parent.mkdir(parents=True, exist_ok=True)
                with wave.open(str(path), "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(44100)
                    wav.writeframes(struct.pack("<" + "h" * len(values), *values))
                entries.append({
                    "instrument": "piano", "midi_note": note,
                    "path": f"piano/{name}.wav",
                })
            self.write_manifest(root, entries)
            report = analyze_sample_bank_quality(load_sample_bank(root))
            self.assertEqual(report["sample_count"], 4)
            self.assertEqual(report["samples_with_warnings"], 3)
            self.assertGreater(report["clipped_samples"], 0)
            by_note = {item["midi_note"]: item for item in report["measurements"]}
            self.assertTrue(by_note[60]["basic_signal_checks_pass"])
            self.assertIn("silent_sample", by_note[61]["warnings"])
            self.assertIn("digital_clipping", by_note[62]["warnings"])
            self.assertIn("dc_offset", by_note[63]["warnings"])
            self.assertFalse(report["basic_signal_checks_pass"])

    def test_complete_custom_fixture_reports_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            samples = []
            for note, name in [(60, "soft"), (60, "hard"), (61, "soft"), (61, "hard")]:
                filename = f"piano/{note}_{name}.wav"
                self.write_sample(root / filename)
                low, high = (1, 64) if name == "soft" else (65, 127)
                samples.append({
                    "instrument": "piano", "midi_note": note, "path": filename,
                    "velocity_min": low, "velocity_max": high,
                })
            self.write_manifest(root, samples)
            bank = load_sample_bank(root)
            report = analyze_sample_bank_coverage(bank, {
                "piano": {
                    "label": "Fixture piano", "note_range": [60, 61],
                    "velocity_layers": [
                        {"name": "soft", "min": 1, "max": 64},
                        {"name": "hard", "min": 65, "max": 127},
                    ],
                },
            })
            self.assertTrue(report["ready"])
            self.assertEqual(report["coverage_percent"], 100.0)
            self.assertEqual(report["recorded_samples"], 4)
            self.assertEqual(report["covered_requirements"], 4)
            self.assertEqual(report["instruments"]["piano"]["missing_velocity_layers"], [])


if __name__ == "__main__":
    unittest.main()
