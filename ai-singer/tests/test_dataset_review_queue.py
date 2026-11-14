import csv
import json
import tempfile
import unittest
import wave
from pathlib import Path

from dataset_review_queue import ReviewQueueError, build_review_queue


class DatasetReviewQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "dataset"
        self.root.mkdir()
        self.output_root = Path(self.temp.name) / "private-review"
        self.output_root.mkdir()
        self._wav("pending.wav")
        self._wav("reviewed.wav")
        self.manifest = self.root / "manifest.jsonl"
        self.manifest.write_text("\\n".join(json.dumps(item, ensure_ascii=False) for item in [
            self.record("pending-1", "pending.wav", "unreviewed"),
            self.record("done-1", "reviewed.wav", "reviewed"),
        ]) + "\\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def _wav(self, name):
        with wave.open(str(self.root / name), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(48000)
            output.writeframes(b"\\x01\\x00" * 48000)

    def record(self, rid, audio, status):
        record = {
            "recording_id": rid,
            "audio_path": audio,
            "language": "Persian",
            "speaker_id": "private-speaker",
            "split": "train",
            "transcript": "متن خصوصی",
            "sample_rate": 48000,
            "channels": 1,
            "duration_seconds": 1.0,
            "consent_confirmed": True,
            "rights_basis": "Performer-owned recording with written consent",
            "alignment_status": status,
        }
        if status == "reviewed":
            record["phoneme_alignment"] = [
                {"phoneme": "s", "start_seconds": 0.0, "end_seconds": 0.5}
            ]
            record["notes"] = [
                {"midi_note": 60, "start_seconds": 0.0, "duration_seconds": 1.0}
            ]
        return record

    def test_creates_private_queue_without_reviewed_rows(self):
        output = self.output_root / "queue.csv"
        report = build_review_queue(self.manifest, output, audio_root=self.root)
        self.assertEqual(report["review_queue_recordings"], 1)
        self.assertFalse(report["uploaded"])
        with output.open("r", encoding="utf-8", newline="") as source:
            rows = list(csv.DictReader(source))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["recording_id"], "pending-1")
        self.assertEqual(rows[0]["transcript"], "متن خصوصی")
        self.assertEqual(rows[0]["has_phoneme_alignment"], "False")
        self.assertEqual(rows[0]["has_midi_notes"], "False")

    def test_rejects_output_inside_audio_dataset(self):
        with self.assertRaises(ReviewQueueError):
            build_review_queue(
                self.manifest, self.root / "queue.csv", audio_root=self.root
            )

    def test_manifest_error_does_not_leak_private_values(self):
        broken = self.record("secret-recording", "pending.wav", "unreviewed")
        broken["consent_confirmed"] = False
        self.manifest.write_text(json.dumps(broken), encoding="utf-8")
        with self.assertRaises(ReviewQueueError) as caught:
            build_review_queue(
                self.manifest, self.output_root / "queue.csv", audio_root=self.root
            )
        self.assertNotIn("secret-recording", str(caught.exception))
        self.assertNotIn("pending.wav", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
