from __future__ import annotations

import unittest
from types import SimpleNamespace

from train_waveform_decoder import run_training


class WaveformTrainerCliTests(unittest.TestCase):
    def test_rejects_invalid_device_before_loading_dataset(self):
        args = SimpleNamespace(
            seed=1, device="cuda", manifest="missing.jsonl", audio_root=None,
            epochs=1, batch_size=1, stft_sizes=[512], output_dir="./tmp",
            resume=None,
        )
        # On CPU-only CI, this guard must run before touching the manifest.
        try:
            import torch
        except ImportError:
            self.skipTest("optional PyTorch dependency is not installed")
        if torch.cuda.is_available():
            self.skipTest("CUDA is available in this environment")
        with self.assertRaisesRegex(RuntimeError, "CUDA was requested"):
            run_training(args)


if __name__ == "__main__":
    unittest.main()
