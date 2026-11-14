from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

try:
    import torch
except ImportError:
    torch = None

from waveform_decoder import WaveformDecoderConfig, build_waveform_decoder
from waveform_training_engine import (
    WaveformTrainingConfig, evaluate, load_checkpoint, save_checkpoint, train_one_epoch,
)


def decoder_config():
    return WaveformDecoderConfig(
        mel_bins=40, sample_rate=48000, hop_length=4, initial_channels=32,
        upsample_factors=(2, 2), residual_dilations=(1,), speaker_embedding_size=16,
    )


def batch():
    rng = np.random.default_rng(7)
    frames, mel_bins, ref_frames, hop = 32, 40, 20, 4
    return SimpleNamespace(
        target_log_mel=rng.normal(-5, 0.5, (1, frames, mel_bins)).astype(np.float32),
        target_f0_hz=np.full((1, frames), 220, dtype=np.float32),
        target_voicing_mask=np.ones((1, frames), dtype=np.float32),
        target_log_rms=np.full((1, frames), -2, dtype=np.float32),
        speaker_reference_log_mel=rng.normal(-5, 0.5, (1, ref_frames, mel_bins)).astype(np.float32),
        speaker_reference_frame_mask=np.ones((1, ref_frames), dtype=np.uint8),
        waveform_target=rng.normal(0, 0.1, (1, frames * hop)).astype(np.float32),
        waveform_sample_mask=np.ones((1, frames * hop), dtype=np.uint8),
        sample_rate=48000,
        hop_length=hop,
    )


@unittest.skipIf(torch is None, "optional PyTorch training dependency is not installed")
class WaveformTrainingEngineTests(unittest.TestCase):
    def test_training_and_validation_step_are_finite(self):
        model = build_waveform_decoder(decoder_config())
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-4)
        cfg = WaveformTrainingConfig(stft_sizes=(16, 32))
        training = train_one_epoch(model, [batch()], optimizer, cfg)
        validation = evaluate(model, [batch()], cfg)
        for metrics in (training, validation):
            self.assertEqual(metrics["batches"], 1)
            self.assertTrue(all(np.isfinite(value) for value in metrics.values()))

    def test_checkpoint_round_trip_and_config_gate(self):
        cfg = decoder_config()
        model = build_waveform_decoder(cfg)
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-4)
        train_one_epoch(model, [batch()], optimizer, WaveformTrainingConfig(stft_sizes=(16, 32)))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "waveform.pt"
            save_checkpoint(
                path, model, optimizer, epoch=2, metrics={"validation_loss": 0.5},
                decoder_config=cfg, training_config=WaveformTrainingConfig(stft_sizes=(16, 32)),
            )
            restored = build_waveform_decoder(cfg)
            restored_optimizer = torch.optim.AdamW(restored.parameters(), lr=1e-4)
            metadata = load_checkpoint(
                path, restored, restored_optimizer, expected_decoder_config=cfg
            )
            self.assertEqual(metadata["epoch"], 2)
            for key, value in model.state_dict().items():
                self.assertTrue(torch.equal(value, restored.state_dict()[key]))

    def test_rejects_batch_without_waveform_or_reference(self):
        model = build_waveform_decoder(decoder_config())
        invalid = batch()
        invalid.waveform_target = None
        with self.assertRaisesRegex(ValueError, "paired targets"):
            train_one_epoch(
                model, [invalid], torch.optim.AdamW(model.parameters()),
                WaveformTrainingConfig(stft_sizes=(16, 32)),
            )


if __name__ == "__main__":
    unittest.main()
