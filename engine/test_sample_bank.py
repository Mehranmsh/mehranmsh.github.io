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
    analyze_sample_bank_instrument_health,
    build_sample_recording_checklist,
    build_sample_recording_sheet_csv,
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

    def test_rejects_malformed_loop_metadata_boundaries_and_types(self):
        invalid_loops = [
            {"loop_start_frame": 0},
            {"loop_end_frame": 32},
            {"loop_start_frame": -1, "loop_end_frame": 32},
            {"loop_start_frame": 0, "loop_end_frame": 10000},
            {"loop_start_frame": 128, "loop_end_frame": 128},
            {"loop_start_frame": 120, "loop_end_frame": 127},
            {"loop_start_frame": True, "loop_end_frame": 32},
            {"loop_start_frame": 0, "loop_end_frame": 32.0},
        ]
        for loop_metadata in invalid_loops:
            with self.subTest(loop_metadata=loop_metadata), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                self.write_sample(root / "piano.wav")
                entry = {"instrument": "piano", "midi_note": 60, "path": "piano.wav"}
                entry.update(loop_metadata)
                self.write_manifest(root, [entry])
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


    def test_instrument_health_aggregates_coverage_signal_and_format_read_only(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for filename, channels, rate in (("c4.wav", 2, 48000), ("c4_bad.wav", 1, 44100)):
                sample_path = root / "piano" / filename
                sample_path.parent.mkdir(parents=True, exist_ok=True)
                values = [4096, -4096] * 128 * channels
                with wave.open(str(sample_path), "wb") as wav:
                    wav.setnchannels(channels)
                    wav.setsampwidth(2)
                    wav.setframerate(rate)
                    wav.writeframes(struct.pack("<" + "h" * len(values), *values))
            self.write_manifest(root, [
                {"instrument": "piano", "midi_note": 60, "path": "piano/c4.wav",
                 "velocity_min": 1, "velocity_max": 127},
                {"instrument": "piano", "midi_note": 61, "path": "piano/c4_bad.wav",
                 "velocity_min": 1, "velocity_max": 127,
                 "loop_start_frame": 0, "loop_end_frame": 16},
            ])
            bank = load_sample_bank(root)
            before = (root / "piano" / "c4.wav").read_bytes()
            health = analyze_sample_bank_instrument_health(bank)
            piano = health["instruments"]["piano"]
            guitar = health["instruments"]["acoustic_guitar"]
            self.assertTrue(health["read_only"])
            self.assertEqual(piano["recorded_samples"], 2)
            self.assertEqual(piano["sample_rates"], [44100, 48000])
            self.assertEqual(piano["channel_counts"], [1, 2])
            self.assertEqual(piano["bit_depths"], [16])
            self.assertEqual(piano["status"], "needs_attention")
            self.assertEqual(piano["looped_samples"], 1)
            self.assertEqual(piano["unlooped_samples"], 1)
            self.assertEqual(piano["loop_boundary_warning_count"], 1)
            self.assertEqual(piano["max_loop_boundary_jump"], 0.25)
            self.assertEqual(guitar["status"], "missing")
            self.assertEqual(guitar["recorded_samples"], 0)
            self.assertEqual(guitar["loop_boundary_warning_count"], 0)
            self.assertIsNone(guitar["max_loop_boundary_jump"])
            self.assertFalse(guitar["coverage_ready"])
            self.assertEqual((root / "piano" / "c4.wav").read_bytes(), before)


    def test_recording_checklist_expands_note_and_velocity_targets(self):
        checklist = build_sample_recording_checklist()
        piano = checklist["instruments"]["piano"]
        self.assertEqual(checklist["instrument_count"], 9)
        self.assertEqual(piano["target_count"], 61 * 3)
        self.assertEqual(piano["targets"][0], {
            "midi_note": 36, "velocity_layer": "soft",
            "velocity_min": 1, "velocity_max": 48,
        })
        self.assertEqual(checklist["format_requirements"]["bit_depth"], 16)
        self.assertGreater(checklist["total_recording_targets"], 0)

    def test_recording_sheet_csv_expands_targets_and_marks_them_as_planned(self):
        content = build_sample_recording_sheet_csv()
        rows = list(csv.DictReader(content.lstrip("\\ufeff").splitlines()))
        checklist = build_sample_recording_checklist()
        self.assertEqual(len(rows), checklist["total_recording_targets"])
        self.assertEqual(rows[0]["instrument"], "piano")
        self.assertEqual(rows[0]["midi_note"], "36")
        self.assertEqual(rows[0]["velocity_layer"], "soft")
        self.assertEqual(rows[0]["recording_status"], "planned")
        self.assertEqual(rows[0]["suggested_filename"], "piano/36_soft.wav")
        self.assertEqual(rows[0]["recorded_file_path"], "")

    def test_quality_report_includes_audio_format_and_loop_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sample_path = root / "piano.wav"
            values = [4096, -4096] * 128
            with wave.open(str(sample_path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(44100)
                wav.writeframes(struct.pack("<" + "h" * len(values), *values))
            self.write_manifest(root, [{
                "instrument": "piano", "midi_note": 60, "path": "piano.wav",
                "loop_start_frame": 0, "loop_end_frame": 128,
            }])
            report = analyze_sample_bank_quality(load_sample_bank(root))
            measurement = report["measurements"][0]
            self.assertEqual(measurement["sample_rate"], 44100)
            self.assertEqual(measurement["channels"], 1)
            self.assertEqual(measurement["bit_depth"], 16)
            self.assertTrue(measurement["loop_present"])
            self.assertEqual(measurement["loop_duration_seconds"], round(128 / 44100, 4))

    def test_loop_boundary_jump_diagnostics_cover_smooth_discontinuous_stereo_and_unlooped(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fixtures = [
                ("smooth.wav", 1, [1000] * 16 + [1200] * 16, True),
                ("jump.wav", 1, [-12000] + [-12000] * 14 + [12000] + [12000] * 16, True),
                ("stereo.wav", 2, [1000, -1000] + [1000, -1000] * 14 + [1000, 12000] + [1000, 12000] * 16, True),
                ("plain.wav", 1, [1000] * 32, False),
            ]
            entries = []
            for filename, channels, values, has_loop in fixtures:
                path = root / filename
                with wave.open(str(path), "wb") as wav:
                    wav.setnchannels(channels)
                    wav.setsampwidth(2)
                    wav.setframerate(44100)
                    wav.writeframes(struct.pack("<" + "h" * len(values), *values))
                entry = {"instrument": "piano", "midi_note": 60 + len(entries),
                         "path": filename}
                if has_loop:
                    entry.update({"loop_start_frame": 0, "loop_end_frame": 16})
                entries.append(entry)
            self.write_manifest(root, entries)
            report = analyze_sample_bank_quality(load_sample_bank(root))
            by_note = {item["midi_note"]: item for item in report["measurements"]}
            self.assertEqual(by_note[60]["loop_boundary_jump"], 0.0)
            self.assertNotIn("loop_boundary_discontinuity", by_note[60]["warnings"])
            self.assertGreater(by_note[61]["loop_boundary_jump"], 0.10)
            self.assertIn("loop_boundary_discontinuity", by_note[61]["warnings"])
            self.assertGreater(by_note[62]["loop_boundary_jump"], 0.10)
            self.assertIn("loop_boundary_discontinuity", by_note[62]["warnings"])
            self.assertIsNone(by_note[63]["loop_boundary_jump"])
            self.assertNotIn("loop_boundary_discontinuity", by_note[63]["warnings"])

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
