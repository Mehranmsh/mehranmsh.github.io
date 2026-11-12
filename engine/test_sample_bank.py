import csv
import json
import math
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank import (
    SAMPLE_INSTRUMENT_CATALOG,
    SAMPLE_ARTICULATION_CATALOG,
    analyze_recording_provenance,
    analyze_sample_bank_coverage,
    analyze_sample_bank_quality,
    analyze_sample_bank_tuning,
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

    def test_recording_session_metadata_is_linked_and_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "piano" / "c2.wav")
            self.write_manifest(root, [{
                "instrument": "piano", "midi_note": 36,
                "path": "piano/c2.wav",
                "recording_session_id": "session-001",
            }])
            manifest = json.loads((root / "bank.json").read_text(encoding="utf-8"))
            manifest["recording_sessions"] = {
                "session-001": {
                    "instrument_model": "Grand Piano Model X",
                    "performer": "Studio Performer",
                    "tuning": "A440",
                    "microphone": "Stereo Pair",
                }
            }
            self.write_manifest(root, manifest["samples"])
            manifest_path = root / "bank.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            bank = load_sample_bank(root)
            report = analyze_recording_provenance(bank)
            self.assertEqual(bank.samples[0].recording_session_id, "session-001")
            self.assertEqual(bank.samples[0].recording_metadata["tuning"], "A440")
            self.assertEqual(report["linked_samples"], 1)
            self.assertEqual(report["unlinked_samples"], 0)
            self.assertEqual(report["session_count"], 1)
            self.assertEqual(
                report["metadata_field_coverage"]["performer"]["recorded_samples"], 1
            )
            self.assertFalse(report["complete_provenance"])

    def test_recording_session_reference_must_exist(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "piano" / "c2.wav")
            self.write_manifest(root, [{
                "instrument": "piano", "midi_note": 36,
                "path": "piano/c2.wav",
                "recording_session_id": "missing-session",
            }])
            with self.assertRaisesRegex(ValueError, "recording_session_id"):
                load_sample_bank(root)

    def test_recording_session_metadata_rejects_unknown_fields(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "piano" / "c2.wav")
            manifest = {
                "format_version": 1,
                "recording_sessions": {"session-01": {"secret": "not allowed"}},
                "samples": [{
                    "instrument": "piano", "midi_note": 36,
                    "path": "piano/c2.wav",
                    "recording_session_id": "session-01",
                }],
            }
            (root / "bank.json").write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Unknown recording metadata"):
                load_sample_bank(root)

    def test_sample_selection_requires_exact_articulation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "piano" / "c4_sustain.wav")
            self.write_sample(root / "piano" / "c4_staccato.wav")
            self.write_manifest(root, [
                {"instrument": "piano", "midi_note": 60,
                 "path": "piano/c4_sustain.wav", "articulation": "sustain"},
                {"instrument": "piano", "midi_note": 60,
                 "path": "piano/c4_staccato.wav", "articulation": "staccato"},
            ])
            bank = load_sample_bank(root)
            self.assertEqual(select_sample(bank, "piano", 60, 80, "sustain").articulation, "sustain")
            self.assertEqual(select_sample(bank, "piano", 60, 80, "staccato").articulation, "staccato")
            with self.assertRaisesRegex(ValueError, "No recorded pizzicato"):
                select_sample(bank, "piano", 60, 80, "pizzicato")

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

    def test_catalog_includes_every_current_renderer_instrument(self):
        renderer_instruments = {
            "piano", "acoustic_guitar", "electric_bass", "strings",
            "electric_guitar", "kick", "snare", "closed_hat", "open_hat",
        }
        self.assertTrue(renderer_instruments.issubset(SAMPLE_INSTRUMENT_CATALOG))
        self.assertEqual(SAMPLE_INSTRUMENT_CATALOG["piano"]["note_range"], [36, 96])

    def test_catalog_expands_iranian_orchestral_and_global_instruments(self):
        expected = {
            "tar", "setar", "santur", "ney", "kamancheh", "oud",
            "qanun", "daf", "tombak", "violin", "viola", "cello",
            "contrabass", "flute", "clarinet", "oboe", "bassoon",
            "trumpet", "trombone", "french_horn", "harp",
            "classical_guitar", "mandolin", "banjo", "accordion",
            "harmonica",
        }
        self.assertTrue(expected.issubset(SAMPLE_INSTRUMENT_CATALOG))
        for spec in SAMPLE_INSTRUMENT_CATALOG.values():
            low, high = spec["note_range"]
            self.assertGreaterEqual(low, 0)
            self.assertLessEqual(high, 127)
            self.assertLessEqual(low, high)
            self.assertTrue(spec["velocity_layers"])

    def test_recording_checklist_groups_targets_into_low_middle_high_zones(self):
        checklist = build_sample_recording_checklist()
        piano = checklist["instruments"]["piano"]
        self.assertEqual(
            [zone["name"] for zone in piano["register_zones"]],
            ["low", "middle", "high"],
        )
        self.assertEqual(piano["register_zones"][0]["note_min"], 36)
        self.assertEqual(piano["register_zones"][-1]["note_max"], 96)
        self.assertEqual(
            {target["register_zone"] for target in piano["targets"]},
            {"low", "middle", "high"},
        )
        self.assertEqual(
            checklist["instruments"]["kick"]["register_zones"],
            [{"name": "single", "note_min": 36, "note_max": 36}],
        )
        self.assertEqual(checklist["catalog_version"], 3)

    def test_register_zone_partition_has_no_gaps_or_overlaps(self):
        from sample_bank import _register_zones
        for low, high in ((24, 96), (40, 88), (48, 84), (36, 36)):
            zones = _register_zones(low, high)
            covered = [
                note for zone in zones
                for note in range(zone["note_min"], zone["note_max"] + 1)
            ]
            self.assertEqual(covered, list(range(low, high + 1)))

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


    def test_coverage_requires_each_requested_articulation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "piano" / "c4_sustain.wav")
            self.write_manifest(root, [{
                "instrument": "piano", "midi_note": 60,
                "path": "piano/c4_sustain.wav", "articulation": "sustain",
            }])
            report = analyze_sample_bank_coverage(
                load_sample_bank(root),
                {"piano": {
                    "label": "Fixture piano", "note_range": [60, 60],
                    "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
                }},
                {"piano": ["sustain", "staccato"]},
            )
            piano = report["instruments"]["piano"]
            self.assertFalse(report["ready"])
            self.assertEqual(report["required_requirements"], 2)
            self.assertEqual(report["covered_requirements"], 1)
            self.assertEqual(piano["missing_articulations"], ["staccato"])
            self.assertEqual(piano["missing_velocity_layers"][0]["articulation"], "staccato")

    def test_recording_checklist_expands_note_and_velocity_targets(self):
        checklist = build_sample_recording_checklist()
        piano = checklist["instruments"]["piano"]
        self.assertEqual(checklist["instrument_count"], len(SAMPLE_INSTRUMENT_CATALOG))
        self.assertEqual(piano["target_count"], 61 * 3 * 2)
        self.assertEqual(piano["targets"][0], {
            "midi_note": 36, "register_zone": "low", "velocity_layer": "soft",
            "velocity_min": 1, "velocity_max": 48,
            "articulation": "sustain",
        })
        self.assertEqual(piano["articulations"], ["sustain", "staccato"])
        self.assertEqual(checklist["catalog_version"], 3)
        self.assertEqual(set(SAMPLE_ARTICULATION_CATALOG), set(SAMPLE_INSTRUMENT_CATALOG))
        self.assertIn("pizzicato", checklist["instruments"]["violin"]["articulations"])
        self.assertIn("mezrab_down", checklist["instruments"]["tar"]["articulations"])
        self.assertEqual(checklist["format_requirements"]["bit_depth"], 16)
        self.assertGreater(checklist["total_recording_targets"], 0)

    def test_custom_articulation_checklist_rejects_invalid_or_duplicate_labels(self):
        catalog = {
            "test_instrument": {
                "label": "Test instrument",
                "note_range": [60, 60],
                "velocity_layers": [{"name": "main", "min": 1, "max": 127}],
            },
        }
        checklist = build_sample_recording_checklist(
            catalog, {"test_instrument": ["sustain", "staccato"]}
        )
        self.assertEqual(checklist["total_recording_targets"], 2)
        self.assertEqual(
            [target["articulation"] for target in checklist["instruments"]["test_instrument"]["targets"]],
            ["sustain", "staccato"],
        )
        with self.assertRaisesRegex(ValueError, "Invalid articulation"):
            build_sample_recording_checklist(catalog, {"test_instrument": ["sustain", "bad label"]})
        with self.assertRaisesRegex(ValueError, "Invalid articulation"):
            build_sample_recording_checklist(catalog, {"test_instrument": ["sustain", "sustain"]})

    def test_recording_sheet_csv_expands_targets_and_marks_them_as_planned(self):
        content = build_sample_recording_sheet_csv()
        rows = list(csv.DictReader(content.lstrip("\ufeff").splitlines()))
        checklist = build_sample_recording_checklist()
        self.assertEqual(len(rows), checklist["total_recording_targets"])
        self.assertEqual(rows[0]["instrument"], "piano")
        self.assertEqual(rows[0]["articulation"], "sustain")
        self.assertEqual(rows[0]["midi_note"], "36")
        self.assertEqual(rows[0]["velocity_layer"], "soft")
        self.assertEqual(rows[0]["recording_status"], "planned")
        self.assertEqual(rows[0]["suggested_filename"], "piano/sustain/36_soft.wav")
        self.assertEqual(rows[0]["recorded_file_path"], "")

    def test_coverage_progress_is_broken_down_by_register_articulation_and_velocity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "fixture" / "low_soft.wav")
            self.write_sample(root / "fixture" / "middle_hard.wav")
            self.write_manifest(root, [
                {"instrument": "fixture", "midi_note": 60,
                 "path": "fixture/low_soft.wav", "velocity_min": 1,
                 "velocity_max": 63, "articulation": "sustain"},
                {"instrument": "fixture", "midi_note": 61,
                 "path": "fixture/middle_hard.wav", "velocity_min": 64,
                 "velocity_max": 127, "articulation": "sustain"},
            ])
            catalog = {"fixture": {
                "label": "Fixture instrument",
                "note_range": [60, 62],
                "velocity_layers": [
                    {"name": "soft", "min": 1, "max": 63},
                    {"name": "hard", "min": 64, "max": 127},
                ],
            }}
            report = analyze_sample_bank_coverage(
                load_sample_bank(root), catalog, {"fixture": ["sustain"]}
            )
            item = report["instruments"]["fixture"]
            self.assertEqual(report["catalog_version"], 3)
            self.assertEqual(report["required_requirements"], 6)
            self.assertEqual(report["covered_requirements"], 2)
            self.assertEqual(report["missing_requirements"], 4)
            self.assertEqual(item["register_zone_progress"]["low"]["covered"], 1)
            self.assertEqual(item["register_zone_progress"]["middle"]["covered"], 1)
            self.assertEqual(item["register_zone_progress"]["high"]["missing"], 2)
            self.assertEqual(item["articulation_progress"]["sustain"]["covered"], 2)
            self.assertEqual(item["velocity_layer_progress"]["soft"]["covered"], 1)
            self.assertEqual(item["velocity_layer_progress"]["hard"]["covered"], 1)
            self.assertFalse(item["ready"])

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

    def test_quality_analysis_measures_head_tail_silence_and_attack(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "piano" / "padded.wav"
            path.parent.mkdir(parents=True, exist_ok=True)
            rate = 10000
            silence = [0] * 1000
            tone = [
                int(10000 * math.sin(2 * math.pi * 440 * i / rate))
                for i in range(3000)
            ]
            values = silence + tone + silence
            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(rate)
                wav.writeframes(struct.pack("<" + "h" * len(values), *values))
            self.write_manifest(root, [{
                "instrument": "piano", "midi_note": 69, "path": "piano/padded.wav",
            }])
            report = analyze_sample_bank_quality(load_sample_bank(root))
            measured = report["measurements"][0]
            self.assertAlmostEqual(measured["leading_low_level_seconds"], 0.1, delta=0.02)
            self.assertAlmostEqual(measured["trailing_low_level_seconds"], 0.1, delta=0.02)
            self.assertIsNotNone(measured["attack_to_10_percent_seconds"])
            self.assertIsNotNone(measured["quiet_region_rms"])
            self.assertEqual(measured["boundary_analysis_status"], "measured")

    def test_tuning_analysis_estimates_reference_pitch_offset(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "piano" / "a4.wav"
            path.parent.mkdir(parents=True, exist_ok=True)
            rate = 48000
            frequency = 440.0 * (2 ** (20.0 / 1200.0))
            values = [
                int(12000 * math.sin(2 * math.pi * frequency * i / rate))
                for i in range(rate // 3)
            ]
            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(rate)
                wav.writeframes(struct.pack("<" + "h" * len(values), *values))
            self.write_manifest(root, [{
                "instrument": "piano", "midi_note": 69, "path": "piano/a4.wav",
            }])
            report = analyze_sample_bank_tuning(load_sample_bank(root))
            measured = report["measurements"][0]
            self.assertEqual(measured["status"], "estimated")
            self.assertAlmostEqual(measured["deviation_cents"], 20.0, delta=3.0)
            self.assertFalse(measured["within_tolerance"])
            self.assertEqual(report["instrument_profiles"]["piano"]["outside_tolerance_samples"], 1)

    def test_tuning_analysis_skips_percussion_without_pitch_claim(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_sample(root / "kick" / "kick.wav")
            self.write_manifest(root, [{
                "instrument": "kick", "midi_note": 36, "path": "kick/kick.wav",
            }])
            report = analyze_sample_bank_tuning(load_sample_bank(root))
            self.assertEqual(
                report["measurements"][0]["status"], "not_applicable_percussion"
            )
            self.assertEqual(report["estimated_samples"], 0)

    def test_tuning_analysis_rejects_weak_periodicity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "piano" / "weak.wav"
            path.parent.mkdir(parents=True, exist_ok=True)
            rate = 44100
            # A short decaying transient is not a stable pitched sustain.
            values = [
                int(14000 * math.exp(-i / 180.0) * (1 if i % 2 else -1))
                for i in range(4096)
            ]
            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(rate)
                wav.writeframes(struct.pack("<" + "h" * len(values), *values))
            self.write_manifest(root, [{
                "instrument": "piano", "midi_note": 69, "path": "piano/weak.wav",
            }])
            report = analyze_sample_bank_tuning(load_sample_bank(root))
            self.assertNotEqual(report["measurements"][0]["status"], "estimated")

    def test_tuning_analysis_reports_inconclusive_noise(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "piano" / "noise.wav"
            path.parent.mkdir(parents=True, exist_ok=True)
            values = [((i * 7919) % 24000) - 12000 for i in range(4096)]
            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(44100)
                wav.writeframes(struct.pack("<" + "h" * len(values), *values))
            self.write_manifest(root, [{
                "instrument": "piano", "midi_note": 69, "path": "piano/noise.wav",
            }])
            report = analyze_sample_bank_tuning(load_sample_bank(root))
            self.assertNotEqual(report["measurements"][0]["status"], "estimated")

    def test_quality_report_groups_recording_profiles_by_instrument(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fixtures = [
                ("piano/soft.wav", 1, 44100, [1000, -1000] * 64),
                ("piano/hard.wav", 2, 48000, [12000, -12000, 8000, -8000] * 32),
            ]
            entries = []
            for index, (filename, channels, rate, values) in enumerate(fixtures):
                path = root / filename
                path.parent.mkdir(parents=True, exist_ok=True)
                with wave.open(str(path), "wb") as wav:
                    wav.setnchannels(channels)
                    wav.setsampwidth(2)
                    wav.setframerate(rate)
                    wav.writeframes(struct.pack("<" + "h" * len(values), *values))
                entries.append({
                    "instrument": "piano", "midi_note": 60 + index,
                    "path": filename,
                })
            self.write_manifest(root, entries)
            report = analyze_sample_bank_quality(load_sample_bank(root))
            profile = report["instrument_profiles"]["piano"]
            self.assertEqual(profile["sample_count"], 2)
            self.assertEqual(profile["sample_rates_hz"], [44100, 48000])
            self.assertEqual(profile["channels_present"], [1, 2])
            self.assertFalse(profile["sample_rate_consistent"])
            self.assertFalse(profile["channel_layout_consistent"])
            self.assertGreater(profile["rms"]["spread"], 0)
            self.assertEqual(profile["samples_with_warnings"], 0)

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
            }, {"piano": ["sustain"]})
            self.assertTrue(report["ready"])
            self.assertEqual(report["coverage_percent"], 100.0)
            self.assertEqual(report["recorded_samples"], 4)
            self.assertEqual(report["covered_requirements"], 4)
            self.assertEqual(report["instruments"]["piano"]["missing_velocity_layers"], [])


if __name__ == "__main__":
    unittest.main()
