import json
import tempfile
import unittest
import wave
from pathlib import Path

from dataset_manifest import ManifestError, validate_manifest


class DatasetManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.audio = self.root / "voice.wav"
        with wave.open(str(self.audio), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(24000)
            output.writeframes(b"\x00\x00" * 2400)

    def tearDown(self):
        self.temp.cleanup()

    def record(self, **changes):
        record = {
            "recording_id": "rec-001",
            "audio_path": "voice.wav",
            "language": "Persian",
            "speaker_id": "speaker-001",
            "split": "train",
            "transcript": "سلام",
            "sample_rate": 24000,
            "channels": 1,
            "duration_seconds": 0.1,
            "consent_confirmed": True,
            "rights_basis": "Performer-owned recording with written consent",
            "alignment_status": "unreviewed",
        }
        record.update(changes)
        return record

    def write_manifest(self, records):
        path = self.root / "manifest.jsonl"
        path.write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in records), encoding="utf-8")
        return path

    def test_accepts_valid_consented_recording(self):
        result = validate_manifest(self.write_manifest([self.record()]))
        self.assertTrue(result["valid"])
        self.assertEqual(result["recording_count"], 1)
        self.assertFalse(result["speaker_split_leakage"])
        self.assertFalse(result["training_started"])

    def test_rejects_missing_performer_consent(self):
        with self.assertRaisesRegex(ManifestError, "explicit performer consent"):
            validate_manifest(self.write_manifest([self.record(consent_confirmed=False)]))

    def test_rejects_missing_rights_basis(self):
        with self.assertRaisesRegex(ManifestError, "rights_basis"):
            validate_manifest(self.write_manifest([self.record(rights_basis=" ")]))

    def test_rejects_path_traversal(self):
        with self.assertRaisesRegex(ManifestError, "contain traversal"):
            validate_manifest(self.write_manifest([self.record(audio_path="../outside.wav")]))

    def test_rejects_speaker_leakage_between_splits(self):
        second = self.record(recording_id="rec-002", split="test")
        with self.assertRaisesRegex(ManifestError, "speaker leakage"):
            validate_manifest(self.write_manifest([self.record(), second]))

    def test_reviewed_alignment_requires_phoneme_spans(self):
        with self.assertRaisesRegex(ManifestError, "requires phoneme_alignment"):
            validate_manifest(self.write_manifest([self.record(alignment_status="reviewed")]))

    def test_reviewed_alignment_checks_timing(self):
        record = self.record(
            alignment_status="reviewed",
            phoneme_alignment=[
                {"phoneme": "s", "start_seconds": 0.0, "end_seconds": 0.06},
                {"phoneme": "a", "start_seconds": 0.05, "end_seconds": 0.1},
            ],
        )
        with self.assertRaisesRegex(ManifestError, "ordered, non-overlapping"):
            validate_manifest(self.write_manifest([record]))

    def test_rejects_header_metadata_mismatch(self):
        with self.assertRaisesRegex(ManifestError, "does not match WAV header"):
            validate_manifest(self.write_manifest([self.record(sample_rate=48000)]))

    def test_rejects_duplicate_recording_ids(self):
        with self.assertRaisesRegex(ManifestError, "duplicate recording_id"):
            validate_manifest(self.write_manifest([self.record(), self.record()]))

    def test_rejects_empty_manifest(self):
        with self.assertRaisesRegex(ManifestError, "no recording records"):
            validate_manifest(self.write_manifest([]))


if __name__ == "__main__":
    unittest.main()
