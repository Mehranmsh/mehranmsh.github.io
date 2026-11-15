import json
import tempfile
import unittest
import wave
from pathlib import Path

from dataset_audit import DatasetAuditError, audit_dataset


class DatasetAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self._wav("train.wav", 48000)
        self._wav("train2.wav", 48000)
        self._wav("train-ref.wav", 48000)
        self._wav("valid.wav", 48000)
        self._wav("valid-ref.wav", 48000)

    def tearDown(self):
        self.temp.cleanup()

    def _wav(self, name, rate):
        with wave.open(str(self.root / name), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            sample = (sum(name.encode("utf-8")) % 200 + 1).to_bytes(2, "little")
            output.writeframes(sample * rate)

    def record(self, rid, audio, split, speaker, **extra):
        value = {
            "recording_id": rid, "audio_path": audio, "language": "Persian",
            "speaker_id": speaker, "split": split, "transcript": "سلام",
            "sample_rate": 48000, "channels": 1, "duration_seconds": 1.0,
            "consent_confirmed": True, "rights_basis": "Performer-owned recording with written consent",
            "alignment_status": "reviewed",
            "phoneme_alignment": [{"phoneme": "s", "start_seconds": 0.0, "end_seconds": 0.5}],
            "notes": [{"midi_note": 60, "start_seconds": 0.0, "duration_seconds": 1.0}],
        }
        value.update(extra)
        return value

    def write(self, records):
        path = self.root / "manifest.jsonl"
        path.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in records), encoding="utf-8")
        return path

    def dataset(self):
        return [
            self.record("tr-target", "train.wav", "train", "speaker-A", speaker_reference_recording_id="tr-ref"),
            self.record("tr-target-2", "train2.wav", "train", "speaker-A", speaker_reference_recording_id="tr-ref"),
            self.record("tr-ref", "train-ref.wav", "train", "speaker-A", speaker_reference_only=True,
                        alignment_status="unreviewed", phoneme_alignment=None, notes=None),
            self.record("va-target", "valid.wav", "validation", "speaker-B",
                        speaker_reference_recording_id="va-ref"),
            self.record("va-ref", "valid-ref.wav", "validation", "speaker-B", speaker_reference_only=True,
                        alignment_status="unreviewed", phoneme_alignment=None, notes=None),
        ]

    def test_reports_aggregate_counts_and_training_readiness(self):
        report = audit_dataset(self.write(self.dataset()), expected_sample_rate=48000)
        self.assertTrue(report["valid"])
        self.assertTrue(report["training_readiness"]["ready_for_staged_training"])
        self.assertEqual(report["splits"]["train"]["training_targets"], 2)
        self.assertEqual(report["splits"]["train"]["speaker_reference_only"], 1)
        self.assertEqual(report["splits"]["validation"]["speaker_reference_pairs"], 1)
        self.assertEqual(report["training_readiness"]["blockers"], [])
        self.assertEqual(report["training_readiness"]["recommended_next_steps"], [])
        self.assertTrue(report["training_readiness"]["dataset_readiness_only"])
        self.assertFalse(report["training_readiness"]["training_can_start_from_audit_alone"])
        # A test split is for held-out evaluation, not a prerequisite for staged training.
        self.assertFalse(report["evaluation_readiness"]["held_out_test_split_available"])
        self.assertEqual(report["evaluation_readiness"]["test_target_recordings"], 0)
        self.assertIn("held-out test split", report["evaluation_readiness"]["recommended_next_step"])
        serialized = json.dumps(report)
        self.assertNotIn("speaker-A", serialized)
        self.assertNotIn("tr-target", serialized)
        self.assertNotIn("train.wav", serialized)
        self.assertNotIn("سلام", serialized)

    def test_requires_two_training_targets_but_not_a_test_split(self):
        records = self.dataset()
        records = [item for item in records if item["recording_id"] != "tr-target-2"]
        report = audit_dataset(self.write(records))
        self.assertFalse(report["training_readiness"]["ready_for_staged_training"])
        self.assertTrue(any("at least two target recordings" in item
                            for item in report["training_readiness"]["blockers"]))
        self.assertTrue(any("at least one more" in item
                            for item in report["training_readiness"]["recommended_next_steps"]))
        self.assertFalse(report["evaluation_readiness"]["held_out_test_split_available"])

    def test_warns_when_reference_pairing_is_absent(self):
        records = self.dataset()
        records[0].pop("speaker_reference_recording_id")
        records[1].pop("speaker_reference_recording_id")
        records[3].pop("speaker_reference_recording_id")
        report = audit_dataset(self.write(records))
        self.assertFalse(report["training_readiness"]["ready_for_staged_training"])
        self.assertTrue(any("references are not configured" in item for item in report["training_readiness"]["warnings"]))

    def test_rejects_partial_reference_pairing_without_leaking_ids(self):
        records = self.dataset()
        records.append(self.record("tr-target-2", "train.wav", "train", "speaker-A"))
        with self.assertRaises(DatasetAuditError) as caught:
            audit_dataset(self.write(records))
        self.assertNotIn("tr-target", str(caught.exception))

    def test_reports_missing_training_annotations_as_warnings(self):
        records = self.dataset()
        records[0]["alignment_status"] = "unreviewed"
        records[0].pop("phoneme_alignment")
        records[0].pop("notes")
        report = audit_dataset(self.write(records))
        self.assertFalse(report["training_readiness"]["ready_for_staged_training"])
        self.assertTrue(any("reviewed phoneme alignment" in item for item in report["training_readiness"]["warnings"]))
        self.assertTrue(any("MIDI note annotations" in item for item in report["training_readiness"]["warnings"]))
        self.assertTrue(report["training_readiness"]["blockers"])
        self.assertTrue(report["training_readiness"]["recommended_next_steps"])

    def test_manifest_validation_failure_does_not_echo_private_metadata(self):
        records = self.dataset()
        records[0]["consent_confirmed"] = False
        with self.assertRaises(DatasetAuditError) as caught:
            audit_dataset(self.write(records))
        self.assertNotIn("tr-target", str(caught.exception))
        self.assertNotIn("train.wav", str(caught.exception))

    def test_reports_annotation_coverage_metrics_without_default_cutoffs(self):
        report = audit_dataset(self.write(self.dataset()), expected_sample_rate=48000)
        quality = report["splits"]["train"]["annotation_quality"]
        self.assertEqual(quality["recordings_analyzed"], 2)
        self.assertAlmostEqual(quality["phoneme_time_coverage"]["mean"], 0.5)
        self.assertEqual(quality["warnings"], [])
        self.assertTrue(report["training_readiness"]["ready_for_staged_training"])

    def test_includes_aggregate_reviewed_syllable_metrics_without_labels(self):
        records = self.dataset()
        records[0]["syllable_alignment"] = [{
            "text": "سَ", "start_seconds": 0.0, "end_seconds": 0.5,
            "phoneme_start_index": 0, "phoneme_end_index": 1,
        }]
        report = audit_dataset(self.write(records))
        metrics = report["splits"]["train"]["annotation_quality"]["syllable_alignment"]
        self.assertEqual(metrics["recordings_with_syllables"], 1)
        self.assertEqual(metrics["total_syllables"], 1)
        self.assertEqual(metrics["duration_seconds"]["mean"], 0.5)
        serialized = json.dumps(report, ensure_ascii=False)
        self.assertNotIn("سَ", serialized)
        self.assertNotIn("tr-target", serialized)
        self.assertNotIn("speaker-A", serialized)

    def test_optional_annotation_thresholds_add_privacy_safe_warnings(self):
        report = audit_dataset(
            self.write(self.dataset()),
            expected_sample_rate=48000,
            minimum_phoneme_coverage=0.9,
            minimum_vowel_note_coverage=0.9,
            maximum_internal_gap_seconds=0.1,
            minimum_phoneme_duration_seconds=0.6,
        )
        self.assertFalse(report["training_readiness"]["ready_for_staged_training"])
        serialized = json.dumps(report)
        self.assertNotIn("tr-target", serialized)
        self.assertNotIn("speaker-A", serialized)
        self.assertTrue(any("low_phoneme_time_coverage" in item
                            for item in report["training_readiness"]["warnings"]))
        self.assertTrue(any("very_short_phoneme_span" in item
                            for item in report["training_readiness"]["warnings"]))

    def test_audit_includes_phoneme_note_coverage_and_optional_threshold(self):
        records = self.dataset()
        records[0]["notes"][0]["duration_seconds"] = 0.25
        report = audit_dataset(
            self.write(records),
            minimum_phoneme_note_coverage=0.8,
        )
        quality = report["splits"]["train"]["annotation_quality"]
        self.assertEqual(quality["phoneme_note_time_coverage"]["phonemes_analyzed"], 2)
        self.assertEqual(quality["phoneme_note_time_coverage"]["uncovered_phonemes"], 0)
        self.assertTrue(any(
            item["code"] == "low_phoneme_note_coverage"
            for item in quality["warnings"]
        ))
        self.assertTrue(any(
            "low_phoneme_note_coverage" in warning
            for warning in report["training_readiness"]["warnings"]
        ))

    def test_rejects_invalid_expected_sample_rate(self):
        with self.assertRaises(DatasetAuditError):
            audit_dataset(self.write(self.dataset()), expected_sample_rate=True)


if __name__ == "__main__":
    unittest.main()
