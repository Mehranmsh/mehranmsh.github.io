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

from model_architecture import SingingNetworkConfig
from waveform_decoder import WaveformDecoderConfig
from singing_pipeline import build_singing_pipeline
from pipeline_training_engine import (
    PipelineTrainingConfig, evaluate, load_checkpoint, save_checkpoint, train_one_epoch,
)
from training_engine import TrainingConfig
from waveform_training_engine import WaveformTrainingConfig


def configs():
    acoustic = SingingNetworkConfig(
        mel_bins=40, hidden_size=32, attention_heads=4, encoder_layers=1,
        convolution_layers=1, feedforward_size=64, dropout=0.0,
    )
    decoder = WaveformDecoderConfig(
        mel_bins=40, sample_rate=48000, hop_length=4, initial_channels=32,
        upsample_factors=(2, 2), residual_dilations=(1,), speaker_embedding_size=16,
    )
    return acoustic, decoder


def batch():
    rng = np.random.default_rng(31)
    bsz, frames, mel_bins, ref_frames, hop = 2, 32, 40, 20, 4
    valid = np.zeros((bsz, frames), dtype=np.uint8)
    valid[0, :] = 1
    valid[1, :24] = 1
    target_f0 = np.full((bsz, frames), 220, dtype=np.float32) * valid
    target_voice = valid.copy()
    return SimpleNamespace(
        recording_ids=("rec-a", "rec-b"),
        lengths=np.array([frames, 24], dtype=np.int32),
        valid_frame_mask=valid,
        phoneme_ids=np.where(valid, 1, 0).astype(np.int32),
        note_ids=np.where(valid, 60, 0).astype(np.int32),
        phoneme_mask=valid.copy(),
        note_mask=valid.copy(),
        conditioning_f0_hz=target_f0.copy(),
        conditioning_voicing_mask=target_voice.copy(),
        conditioning_energy=np.full((bsz, frames), -2, dtype=np.float32) * valid,
        target_log_mel=rng.normal(-5, 0.2, (bsz, frames, mel_bins)).astype(np.float32) * valid[..., None],
        target_f0_hz=target_f0,
        target_voicing_mask=target_voice,
        target_log_rms=np.full((bsz, frames), -2, dtype=np.float32) * valid,
        sample_rate=48000,
        hop_length=hop,
        speaker_reference_log_mel=rng.normal(-5, 0.2, (bsz, ref_frames, mel_bins)).astype(np.float32),
        speaker_reference_frame_mask=np.ones((bsz, ref_frames), dtype=np.uint8),
        waveform_target=rng.normal(0, 0.05, (bsz, frames * hop)).astype(np.float32),
        waveform_sample_mask=np.concatenate([
            np.ones((1, frames * hop), dtype=np.uint8),
            np.concatenate([np.ones((1, 24 * hop), dtype=np.uint8),
                            np.zeros((1, 8 * hop), dtype=np.uint8)], axis=1),
        ], axis=0),
    )


@unittest.skipIf(torch is None, "optional PyTorch training dependency is not installed")
class PipelineTrainingEngineTests(unittest.TestCase):
    def test_joint_training_updates_both_networks_and_validates(self):
        acoustic_cfg, decoder_cfg = configs()
        pipeline = build_singing_pipeline(acoustic_cfg, decoder_cfg)
        optimizer = torch.optim.AdamW(pipeline.parameters(), lr=1e-4)
        cfg = PipelineTrainingConfig(
            acoustic=TrainingConfig(),
            waveform=WaveformTrainingConfig(stft_sizes=(16, 32)),
        )
        before_acoustic = next(pipeline.acoustic_model.parameters()).detach().clone()
        before_decoder = next(pipeline.waveform_decoder.parameters()).detach().clone()
        train_metrics = train_one_epoch(pipeline, [batch()], optimizer, cfg)
        self.assertFalse(torch.equal(before_acoustic, next(pipeline.acoustic_model.parameters()).detach()))
        self.assertFalse(torch.equal(before_decoder, next(pipeline.waveform_decoder.parameters()).detach()))
        validation = evaluate(pipeline, [batch()], cfg)
        for metrics in (train_metrics, validation):
            self.assertEqual(metrics["batches"], 1)
            self.assertTrue(all(np.isfinite(value) for value in metrics.values()))

    def test_joint_checkpoint_round_trip_and_config_gate(self):
        acoustic_cfg, decoder_cfg = configs()
        pipeline = build_singing_pipeline(acoustic_cfg, decoder_cfg)
        optimizer = torch.optim.AdamW(pipeline.parameters(), lr=1e-4)
        cfg = PipelineTrainingConfig(
            waveform=WaveformTrainingConfig(stft_sizes=(16, 32))
        )
        train_one_epoch(pipeline, [batch()], optimizer, cfg)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "joint.pt"
            save_checkpoint(
                path, pipeline, optimizer, epoch=0, metrics={"validation_loss": 1.0},
                acoustic_config=acoustic_cfg, decoder_config=decoder_cfg,
                training_config=cfg,
            )
            restored = build_singing_pipeline(acoustic_cfg, decoder_cfg)
            restored_optimizer = torch.optim.AdamW(restored.parameters(), lr=1e-4)
            metadata = load_checkpoint(
                path, restored, restored_optimizer,
                expected_acoustic_config=acoustic_cfg,
                expected_decoder_config=decoder_cfg,
            )
            self.assertEqual(metadata["epoch"], 0)
            for key, value in pipeline.state_dict().items():
                self.assertTrue(torch.equal(value, restored.state_dict()[key]))
            wrong = SingingNetworkConfig(mel_bins=40, hidden_size=64, attention_heads=4,
                encoder_layers=1, convolution_layers=1, feedforward_size=64, dropout=0.0)
            with self.assertRaisesRegex(ValueError, "acoustic configuration mismatch"):
                load_checkpoint(path, restored, expected_acoustic_config=wrong)

    def test_requires_waveform_targets_and_speaker_reference(self):
        acoustic_cfg, decoder_cfg = configs()
        pipeline = build_singing_pipeline(acoustic_cfg, decoder_cfg)
        invalid = batch()
        invalid.waveform_target = None
        with self.assertRaisesRegex(ValueError, "paired waveform targets"):
            train_one_epoch(
                pipeline, [invalid], torch.optim.AdamW(pipeline.parameters()),
                PipelineTrainingConfig(waveform=WaveformTrainingConfig(stft_sizes=(16, 32))),
            )
        invalid = batch()
        invalid.speaker_reference_log_mel = None
        with self.assertRaisesRegex(ValueError, "separate speaker references"):
            train_one_epoch(
                pipeline, [invalid], torch.optim.AdamW(pipeline.parameters()),
                PipelineTrainingConfig(waveform=WaveformTrainingConfig(stft_sizes=(16, 32))),
            )


if __name__ == "__main__":
    unittest.main()
