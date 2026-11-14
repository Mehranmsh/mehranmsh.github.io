from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
import hashlib
import json
from dataclasses import asdict

try:
    import torch
except ImportError:
    torch = None

from model_architecture import SingingNetworkConfig
from waveform_decoder import WaveformDecoderConfig
from singing_pipeline import build_singing_pipeline
from pipeline_training_engine import PipelineTrainingConfig, save_checkpoint
from training_engine import TrainingConfig
from waveform_training_engine import WaveformTrainingConfig
from model_config import validate_acoustic_model_config
from phoneme_inventory import INVENTORY_VERSION
from joint_model_bundle import MANIFEST_NAME as JOINT_BUNDLE_MANIFEST
from inference_runtime import SingingInferenceRuntime


@unittest.skipIf(torch is None, "optional PyTorch training dependency is not installed")
class SingingInferenceRuntimeTests(unittest.TestCase):
    def configs(self):
        acoustic = SingingNetworkConfig(
            mel_bins=40, hidden_size=32, attention_heads=4, encoder_layers=1,
            convolution_layers=1, feedforward_size=64, dropout=0.0,
        )
        decoder = WaveformDecoderConfig(
            mel_bins=40, sample_rate=48000, hop_length=4, initial_channels=32,
            upsample_factors=(2, 2), residual_dilations=(1,), speaker_embedding_size=16,
        )
        return acoustic, decoder

    def make_checkpoint(self, path, acoustic, decoder):
        pipeline = build_singing_pipeline(acoustic, decoder)
        optimizer = torch.optim.AdamW(pipeline.parameters(), lr=1e-4)
        save_checkpoint(
            path, pipeline, optimizer, epoch=0, metrics={"validation_loss": 1.0},
            acoustic_config=acoustic, decoder_config=decoder,
            training_config=PipelineTrainingConfig(
                acoustic=TrainingConfig(),
                waveform=WaveformTrainingConfig(stft_sizes=(16, 32)),
            ),
        )

    def test_loads_checkpoint_and_writes_verified_wav(self):
        acoustic, decoder = self.configs()
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "joint.pt"
            self.make_checkpoint(checkpoint, acoustic, decoder)
            runtime = SingingInferenceRuntime.from_checkpoint(
                checkpoint, acoustic_config=acoustic, decoder_config=decoder
            )
            status = runtime.status()
            self.assertTrue(status["local_inference_available"])
            self.assertFalse(status["production_approved"])
            frames = 16
            phones = np.ones(frames, dtype=np.int64)
            notes = np.full(frames, 60, dtype=np.int64)
            f0 = np.full(frames, 440, dtype=np.float32)
            voice = np.ones(frames, dtype=np.float32)
            energy = np.full(frames, -2, dtype=np.float32)
            reference = np.zeros((20, 40), dtype=np.float32)
            result = runtime.synthesize_to_wav(
                phones, notes, f0, voice, energy, reference,
                output_directory=directory, project_id="test-project",
            )
            self.assertTrue(result["valid"])
            self.assertEqual(result["frames"], frames * decoder.hop_length)
            self.assertTrue((Path(directory) / result["artifact_path"]).is_file())

    def test_from_bundle_verifies_checkpoint_hash_before_loading(self):
        acoustic, _ = self.configs()
        decoder = WaveformDecoderConfig(
            mel_bins=40, sample_rate=48000, hop_length=64, initial_channels=32,
            upsample_factors=(4, 4, 4), residual_dilations=(1,), speaker_embedding_size=16,
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint = root / "pipeline.pt"
            self.make_checkpoint(checkpoint, acoustic, decoder)
            feature = validate_acoustic_model_config({
                "schema_version": "mehran.svs.acoustic-config.v1",
                "config_id": "mehran-fa-runtime-bundle-v1",
                "language": "fa",
                "phoneme_inventory_version": INVENTORY_VERSION,
                "sample_rate": 48000,
                "n_fft": 2048,
                "win_length": 2048,
                "hop_length": 64,
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
            manifest = {
                "schema_version": "mehran.svs.joint-bundle.v1",
                "bundle_id": "test-bundle",
                "task": "singing_voice_synthesis",
                "languages": ["fa"],
                "sample_rate": 48000,
                "acoustic_feature_config": feature.model_dump(mode="json"),
                "acoustic_model_config": asdict(acoustic),
                "waveform_decoder_config": asdict(decoder),
                "pipeline_checkpoint": {
                    "path": "pipeline.pt",
                    "sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
                },
            }
            (root / JOINT_BUNDLE_MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
            runtime = SingingInferenceRuntime.from_bundle(root)
            self.assertTrue(runtime.status()["bundle_verified"])
            self.assertEqual(runtime.status()["bundle_id"], "test-bundle")
            manifest["pipeline_checkpoint"]["sha256"] = "0" * 64
            (root / JOINT_BUNDLE_MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "hash_mismatch"):
                SingingInferenceRuntime.from_bundle(root)

    def test_rejects_checkpoint_symlink(self):
        acoustic, decoder = self.configs()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint = root / "joint.pt"
            self.make_checkpoint(checkpoint, acoustic, decoder)
            linked = root / "linked.pt"
            linked.symlink_to(checkpoint)
            with self.assertRaisesRegex(ValueError, "non-symlink"):
                SingingInferenceRuntime.from_checkpoint(
                    linked, acoustic_config=acoustic, decoder_config=decoder
                )

    def test_rejects_misaligned_input_tracks(self):
        acoustic, decoder = self.configs()
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "joint.pt"
            self.make_checkpoint(checkpoint, acoustic, decoder)
            runtime = SingingInferenceRuntime.from_checkpoint(
                checkpoint, acoustic_config=acoustic, decoder_config=decoder
            )
            with self.assertRaisesRegex(ValueError, "equal lengths"):
                runtime.synthesize(
                    [1, 1], [60], [440, 440], [1, 1], [-2, -2], np.zeros((20, 40))
                )


if __name__ == "__main__":
    unittest.main()
