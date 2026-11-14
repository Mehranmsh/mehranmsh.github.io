from __future__ import annotations

import unittest
from types import SimpleNamespace

try:
    import torch
except ImportError:
    torch = None

from train_singing_pipeline import run_training


@unittest.skipIf(torch is None, "optional PyTorch training dependency is not installed")
class SingingPipelineCliTests(unittest.TestCase):
    def base_args(self):
        return SimpleNamespace(
            device="cpu", resume=None, acoustic_checkpoint=None,
            waveform_checkpoint=None, manifest="not-read.jsonl", audio_root=None,
            seed=1, sample_rate=48000, hop_length=256, mel_bins=100,
            epochs=1, batch_size=1, acoustic_learning_rate=2e-5,
            waveform_learning_rate=5e-5, stft_sizes=[512], acoustic_loss_weight=1.0,
            waveform_loss_weight=1.0, weight_decay=1e-4, output_dir="./tmp",
        )

    def test_requires_both_pretrained_stage_checkpoints(self):
        with self.assertRaisesRegex(ValueError, "both --acoustic-checkpoint"):
            run_training(self.base_args())

    def test_rejects_resume_and_stage_checkpoints_together(self):
        args = self.base_args()
        args.resume = "joint.pt"
        args.acoustic_checkpoint = "acoustic.pt"
        args.waveform_checkpoint = "waveform.pt"
        with self.assertRaisesRegex(ValueError, "use --resume or"):
            run_training(args)

    def test_rejects_missing_local_checkpoint_before_reading_manifest(self):
        args = self.base_args()
        args.acoustic_checkpoint = "missing-acoustic.pt"
        args.waveform_checkpoint = "missing-waveform.pt"
        with self.assertRaisesRegex(ValueError, "existing regular local file"):
            run_training(args)


if __name__ == "__main__":
    unittest.main()
