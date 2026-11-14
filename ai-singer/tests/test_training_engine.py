from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np

from batch_collator import TrainingBatch
from model_architecture import SingingNetworkConfig, build_singing_model
from training_engine import (
    TrainingConfig,
    evaluate,
    load_checkpoint,
    save_checkpoint,
    train_one_epoch,
)


def make_batch():
    batch, frames, mel_bins = 2, 8, 4
    valid = np.zeros((batch, frames), dtype=np.uint8)
    valid[0, :] = 1
    valid[1, :5] = 1
    phoneme = np.zeros((batch, frames), dtype=np.int32)
    note = np.zeros((batch, frames), dtype=np.int32)
    phoneme[valid.astype(bool)] = 1
    note[valid.astype(bool)] = 60
    f0 = np.zeros((batch, frames), dtype=np.float32)
    f0[valid.astype(bool)] = 220.0
    voice = valid.copy()
    energy = np.zeros((batch, frames), dtype=np.float32)
    log_mel = np.zeros((batch, frames, mel_bins), dtype=np.float32)
    target_rms = np.zeros((batch, frames), dtype=np.float32)
    return TrainingBatch(
        recording_ids=("train-a", "train-b"),
        lengths=np.array([8, 5], dtype=np.int32),
        valid_frame_mask=valid,
        phoneme_ids=phoneme,
        note_ids=note,
        phoneme_mask=(phoneme != 0).astype(np.uint8),
        note_mask=(note != 0).astype(np.uint8),
        conditioning_f0_hz=f0.copy(),
        conditioning_voicing_mask=voice.copy(),
        conditioning_energy=energy.copy(),
        target_log_mel=log_mel,
        target_f0_hz=f0.copy(),
        target_voicing_mask=voice.copy(),
        target_log_rms=target_rms,
        sample_rate=48000,
        hop_length=256,
    )


def model_config():
    return SingingNetworkConfig(
        mel_bins=4, hidden_size=32, attention_heads=4,
        encoder_layers=1, convolution_layers=1,
        feedforward_size=64, dropout=0.0,
    )


@unittest.skipUnless(__import__("importlib").util.find_spec("torch"), "optional PyTorch dependency is not installed")
class TrainingEngineTests(unittest.TestCase):
    def test_train_and_evaluate_return_finite_losses(self):
        import torch

        model = build_singing_model(model_config())
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
        config = TrainingConfig()
        train_metrics = train_one_epoch(model, [make_batch()], optimizer, config)
        valid_metrics = evaluate(model, [make_batch()], config)
        for metrics in (train_metrics, valid_metrics):
            self.assertEqual(metrics["batches"], 1)
            self.assertTrue(all(np.isfinite(value) for value in metrics.values()))

    def test_checkpoint_round_trip_restores_model_and_optimizer(self):
        import torch

        cfg = model_config()
        model = build_singing_model(cfg)
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
        train_one_epoch(model, [make_batch()], optimizer, TrainingConfig())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "best.pt"
            save_checkpoint(
                path, model, optimizer, epoch=3,
                metrics={"loss": 0.25}, model_config=cfg,
                training_config=TrainingConfig(),
            )
            restored = build_singing_model(cfg)
            restored_optimizer = torch.optim.AdamW(restored.parameters(), lr=1e-3)
            metadata = load_checkpoint(
                path, restored, restored_optimizer,
                expected_model_config=cfg,
            )
            self.assertEqual(metadata["epoch"], 3)
            self.assertAlmostEqual(metadata["metrics"]["loss"], 0.25)
            for key, value in model.state_dict().items():
                self.assertTrue(torch.equal(value, restored.state_dict()[key]))

    def test_checkpoint_rejects_model_config_mismatch(self):
        import torch

        cfg = model_config()
        model = build_singing_model(cfg)
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.pt"
            save_checkpoint(
                path, model, optimizer, epoch=0, metrics={},
                model_config=cfg, training_config=TrainingConfig(),
            )
            different = build_singing_model(SingingNetworkConfig(
                mel_bins=4, hidden_size=64, attention_heads=4,
                encoder_layers=1, convolution_layers=1,
                feedforward_size=128, dropout=0.0,
            ))
            with self.assertRaisesRegex(ValueError, "configuration"):
                load_checkpoint(path, different, expected_model_config=SingingNetworkConfig(
                    mel_bins=4, hidden_size=64, attention_heads=4,
                    encoder_layers=1, convolution_layers=1,
                    feedforward_size=128, dropout=0.0,
                ))

    def test_rejects_empty_epoch(self):
        import torch

        model = build_singing_model(model_config())
        optimizer = torch.optim.AdamW(model.parameters())
        with self.assertRaisesRegex(ValueError, "at least one batch"):
            train_one_epoch(model, [], optimizer, TrainingConfig())


if __name__ == "__main__":
    unittest.main()
