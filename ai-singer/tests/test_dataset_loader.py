from __future__ import annotations

import json
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

from dataset_loader import DatasetLoadError, load_training_examples
from model_config import validate_acoustic_model_config
from phoneme_inventory import INVENTORY_VERSION


def config():
    return validate_acoustic_model_config({
        "schema_version": "mehran.svs.acoustic-config.v1",
        "config_id": "mehran-fa-loader-test-v1",
        "language": "fa",
        "phoneme_inventory_version": INVENTORY_VERSION,
        "sample_rate": 48000,
        "n_fft": 2048,
        "win_length": 2048,
        "hop_length": 256,
        "mel_bins": 40,
        "f_min_hz": 40.0,
        "f_max_hz": 16000.0,
        "mel_scale": "slaney",
        "mel_normalization": "slaney",
        "log_floor": 1e-5,
        "frame_alignment": "centered",
        "note_pitch_encoding": "midi_0_127",
        "pitch_track_encoding": "continuous_hz_plus_voicing_mask",
        "energy_track_encoding": "log_rms",
        "target_features": ["log_mel", "f0_hz", "voicing_mask", "log_rms"],
    })


class DatasetLoaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        rate = 48000
        samples = np.arange(4800, dtype=np.float32) / rate
        audio = (0.2 * np.sin(2 * np.pi * 220 * samples) * 32767).astype("<i2")
        with wave.open(str(self.root / "voice.wav"), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes(audio.tobytes())

    def tearDown(self):
        self.temp.cleanup()

    def record(self, **changes):
        item = {
            "recording_id": "rec-001",
            "audio_path": "voice.wav",
            "language": "Persian",
            "speaker_id": "speaker-private-001",
            "split": "train",
            "transcript": "سلام",
            "sample_rate": 48000,
            "channels": 1,
            "duration_seconds": 0.1,
            "consent_confirmed": True,
            "rights_basis": "Performer-owned recording with explicit written consent",
            "alignment_status": "reviewed",
            "phoneme_alignment": [
                {"phoneme": "æ", "start_seconds": 0.0, "end_seconds": 0.1}
            ],
            "notes": [
                {"midi_note": 57, "start_seconds": 0.0, "duration_seconds": 0.1, "velocity": 90}
            ],
        }
        item.update(changes)
        return item

    def write_manifest(self, record):
        path = self.root / "manifest.jsonl"
        path.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
        return path

    def test_loads_reviewed_persian_record_into_aligned_example(self):
        examples = load_training_examples(self.write_manifest(self.record()), config())
        self.assertEqual(len(examples), 1)
        example = examples[0]
        self.assertEqual(example.recording_id, "rec-001")
        self.assertEqual(example.acoustic.log_mel.shape[1], 40)
        self.assertEqual(len(example.acoustic.f0_hz), len(example.tokens.phoneme_ids))
        self.assertEqual(len(example.tokens.note_ids), len(example.pitch_targets.f0_hz))

    def test_requires_reviewed_alignment(self):
        record = self.record(alignment_status="unreviewed")
        with self.assertRaisesRegex(DatasetLoadError, "reviewed phoneme alignment"):
            load_training_examples(self.write_manifest(record), config())

    def test_requires_explicit_note_events(self):
        record = self.record()
        record.pop("notes")
        with self.assertRaisesRegex(DatasetLoadError, "reviewed monophonic notes"):
            load_training_examples(self.write_manifest(record), config())

    def test_rejects_stereo_before_feature_extraction(self):
        record = self.record(channels=2)
        with self.assertRaisesRegex(DatasetLoadError, "mono WAV"):
            load_training_examples(self.write_manifest(record), config())

    def test_loads_only_requested_split(self):
        record = self.record(split="validation")
        with self.assertRaisesRegex(DatasetLoadError, "no records for split: train"):
            load_training_examples(self.write_manifest(record), config())


if __name__ == "__main__":
    unittest.main()
