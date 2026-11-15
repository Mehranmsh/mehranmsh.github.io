import json
import tempfile
import unittest
import wave
from pathlib import Path

from studio_dataset_export import (
    StudioDatasetExportError,
    append_manifest_record,
    build_manifest_record,
)


class StudioDatasetExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.audio = self.root / "take.wav"
        with wave.open(str(self.audio), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes(bytes(4800))
        self.export = {
            "schema": "mehran.svs.conditioning-export.v1",
            "review_required": True,
            "accepted_for_inference": False,
            "audio_generated": False,
            "conditioning": {
                "schema_version": "mehran.svs.conditioning.v1",
                "project_id": "studio-project-1",
                "language": "fa",
                "sample_rate": 24000,
                "duration_seconds": 0.1,
                "phonemes": [{"phoneme": "s", "start_seconds": 0.0, "end_seconds": 0.1}],
                "syllable_alignment": [{
                    "text": "سَ", "start_seconds": 0.0, "end_seconds": 0.1,
                    "phoneme_start_index": 0, "phoneme_end_index": 1,
                }],
                "notes": [{"midi_note": 60, "start_seconds": 0.0, "duration_seconds": 0.1, "velocity": 80}],
                "style": {},
            },
        }

    def tearDown(self):
        self.temp.cleanup()

    def make_record(self, **changes):
        args = {
            "dataset_root": self.root,
            "audio_path": "take.wav",
            "recording_id": "take-001",
            "speaker_id": "speaker-anon-01",
            "split": "train",
            "transcript": "سلام",
            "consent_confirmed": True,
            "rights_basis": "Performer-owned recording; explicit written permission",
        }
        args.update(changes)
        return build_manifest_record(self.export, **args)

    def test_converts_reviewed_export_without_copying_audio(self):
        record = self.make_record()
        self.assertEqual(record["phoneme_alignment"][0]["phoneme"], "s")
        self.assertEqual(record["syllable_alignment"][0]["text"], "سَ")
        self.assertEqual(record["syllable_alignment"][0]["phoneme_end_index"], 1)
        self.assertEqual(record["notes"][0]["midi_note"], 60)
        self.assertEqual(record["audio_path"], "take.wav")
        self.assertEqual(record["duration_seconds"], 0.1)
        self.assertTrue(self.audio.exists())

    def test_requires_explicit_consent(self):
        with self.assertRaisesRegex(StudioDatasetExportError, "explicit performer consent"):
            self.make_record(consent_confirmed=False)

    def test_rejects_inference_accepted_export(self):
        export = dict(self.export, accepted_for_inference=True)
        with self.assertRaisesRegex(StudioDatasetExportError, "non-inference"):
            build_manifest_record(export, **{
                "dataset_root": self.root, "audio_path": "take.wav",
                "recording_id": "take-001", "speaker_id": "speaker-01",
                "split": "train", "transcript": "سلام",
                "consent_confirmed": True, "rights_basis": "Owned",
            })

    def test_rejects_absolute_audio_path(self):
        with self.assertRaisesRegex(StudioDatasetExportError, "relative path"):
            self.make_record(audio_path=str(self.audio))

    def test_rejects_conditioning_sample_rate_mismatch(self):
        export = json.loads(json.dumps(self.export))
        export["conditioning"]["sample_rate"] = 48000
        with self.assertRaisesRegex(StudioDatasetExportError, "sample_rate does not match"):
            build_manifest_record(export, **{
                "dataset_root": self.root, "audio_path": "take.wav",
                "recording_id": "take-001", "speaker_id": "speaker-01",
                "split": "train", "transcript": "سلام",
                "consent_confirmed": True, "rights_basis": "Owned",
            })

    def test_rejects_stereo_for_current_mono_training_frontend(self):
        stereo = self.root / "stereo.wav"
        with wave.open(str(stereo), "wb") as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes(bytes(9600))
        with self.assertRaisesRegex(StudioDatasetExportError, "mono PCM"):
            self.make_record(audio_path="stereo.wav")

    def test_rejects_audio_duration_mismatch(self):
        export = json.loads(json.dumps(self.export))
        export["conditioning"]["duration_seconds"] = 0.3
        with self.assertRaisesRegex(StudioDatasetExportError, "duration does not match"):
            build_manifest_record(export, **{
                "dataset_root": self.root, "audio_path": "take.wav",
                "recording_id": "take-001", "speaker_id": "speaker-01",
                "split": "train", "transcript": "سلام",
                "consent_confirmed": True, "rights_basis": "Owned",
            })

    def test_appends_only_after_full_manifest_validation(self):
        record = self.make_record()
        output = self.root / "manifest.jsonl"
        result = append_manifest_record(output, record, dataset_root=self.root)
        self.assertEqual(result["recording_count"], 1)
        self.assertFalse(result["audio_uploaded"])
        self.assertEqual(len(output.read_text(encoding="utf-8").splitlines()), 1)

    def test_manifest_output_cannot_overwrite_audio(self):
        before = self.audio.read_bytes()
        record = self.make_record()
        with self.assertRaisesRegex(StudioDatasetExportError, "must not overwrite"):
            append_manifest_record(self.audio, record, dataset_root=self.root)
        self.assertEqual(self.audio.read_bytes(), before)

    def test_rejects_symlinked_manifest_parent_directory(self):
        link = self.root / "linked-output"
        try:
            link.symlink_to(self.root, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are unavailable")
        with self.assertRaisesRegex(StudioDatasetExportError, "parent symlinks"):
            append_manifest_record(link / "manifest.jsonl", self.make_record(), dataset_root=self.root)

    def test_concurrent_appends_preserve_every_record(self):
        import threading

        output = self.root / "concurrent.jsonl"
        records = []
        for index in range(4):
            audio_path = self.root / f"take-{index}.wav"
            with wave.open(str(audio_path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(24000)
                wav.writeframes(bytes([index + 1, 0]) * 2400)
            records.append(self.make_record(
                audio_path=audio_path.name,
                recording_id=f"take-{index}",
                speaker_id=f"speaker-{index}",
            ))

        failures = []
        def append(record):
            try:
                append_manifest_record(output, record, dataset_root=self.root)
            except Exception as exc:
                failures.append(exc)

        threads = [threading.Thread(target=append, args=(record,)) for record in records]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(failures, [])
        lines = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(lines), 4)
        self.assertEqual({item["recording_id"] for item in lines},
                         {f"take-{index}" for index in range(4)})

    def test_rejects_duplicate_audio_or_record_id_without_corrupting_manifest(self):
        record = self.make_record()
        output = self.root / "manifest.jsonl"
        append_manifest_record(output, record, dataset_root=self.root)
        before = output.read_text(encoding="utf-8")
        with self.assertRaises(StudioDatasetExportError):
            append_manifest_record(output, record, dataset_root=self.root)
        self.assertEqual(output.read_text(encoding="utf-8"), before)


if __name__ == "__main__":
    unittest.main()
