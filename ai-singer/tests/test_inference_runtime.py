from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np

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
