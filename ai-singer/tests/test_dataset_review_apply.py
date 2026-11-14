import csv
import json
import tempfile
import unittest
import wave
from pathlib import Path

from dataset_review_apply import ReviewApplyError, apply_review_queue
from dataset_review_queue import build_review_queue
from dataset_manifest import validate_manifest


class DatasetReviewApplyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "dataset"
        self.root.mkdir()
        self.private = self.base / "private"
        self.private.mkdir()
        self.manifest = self.root / "manifest.jsonl"
        self._wav("take.wav")
        self.record = {
            "recording_id": "take-1",
            "audio_path": "take.wav",
            "language": "Persian",
            "speaker_id": "speaker-a",
            "split": "train",
            "transcript": "سلام",
            "sample_rate": 48000,
            "channels": 1,
            "duration_seconds": 1.0,
            "consent_confirmed": True,
            "rights_basis": "Performer-owned recording with written consent",
            "alignment_status": "unreviewed",
        }
        self._write_manifest()

    def tearDown(self):
        self.temp.cleanup()

    def _wav(self, name):
        with wave.open(str(self.root / name), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(48000)
            sample = (sum(name.encode("utf-8")) % 200 + 1).to_bytes(2, "little")
            output.writeframes(sample * 48000)

    def _write_manifest(self):
        self.manifest.write_text(json.dumps(self.record, ensure_ascii=False) + "\n", encoding="utf-8")

    def _queue(self):
        output = self.private / "queue.csv"
        build_review_queue(self.manifest, output, audio_root=self.root)
        return output

    def _approve(self, queue):
        with queue.open("r", encoding="utf-8", newline="") as source:
            rows = list(csv.DictReader(source))
            fields = list(rows[0])
        rows[0]["phoneme_alignment_json"] = json.dumps([
            {"phoneme": "s", "start_seconds": 0.0, "end_seconds": 0.4},
            {"phoneme": "a", "start_seconds": 0.4, "end_seconds": 0.8},
        ], ensure_ascii=False)
        rows[0]["notes_json"] = json.dumps([
            {"midi_note": 60, "start_seconds": 0.0, "duration_seconds": 0.8}
        ])
        rows[0]["review_decision"] = "approved"
        with queue.open("w", encoding="utf-8", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)

    def test_applies_approved_annotations_after_full_validation(self):
        queue = self._queue()
        self._approve(queue)
        result = apply_review_queue(self.manifest, queue, audio_root=self.root)
        self.assertEqual(result["approved_updates"], 1)
        self.assertTrue(result["manifest_updated"])
        updated = json.loads(self.manifest.read_text(encoding="utf-8"))
        self.assertEqual(updated["alignment_status"], "reviewed")
        self.assertEqual(len(updated["phoneme_alignment"]), 2)
        self.assertEqual(validate_manifest(self.manifest, self.root)["recording_count"], 1)

    def test_pending_queue_does_not_modify_manifest(self):
        queue = self._queue()
        before = self.manifest.read_bytes()
        result = apply_review_queue(self.manifest, queue, audio_root=self.root)
        self.assertFalse(result["manifest_updated"])
        self.assertEqual(self.manifest.read_bytes(), before)

    def test_rejects_tampered_immutable_metadata(self):
        queue = self._queue()
        self._approve(queue)
        with queue.open("r", encoding="utf-8", newline="") as source:
            rows = list(csv.DictReader(source))
            fields = list(rows[0])
        rows[0]["transcript"] = "متن تغییر یافته"
        with queue.open("w", encoding="utf-8", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
        with self.assertRaises(ReviewApplyError):
            apply_review_queue(self.manifest, queue, audio_root=self.root)

    def test_rejects_invalid_annotations_without_changing_manifest(self):
        queue = self._queue()
        self._approve(queue)
        with queue.open("r", encoding="utf-8", newline="") as source:
            rows = list(csv.DictReader(source))
            fields = list(rows[0])
        rows[0]["phoneme_alignment_json"] = "[]"
        with queue.open("w", encoding="utf-8", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
        before = self.manifest.read_bytes()
        with self.assertRaises(ReviewApplyError):
            apply_review_queue(self.manifest, queue, audio_root=self.root)
        self.assertEqual(self.manifest.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
