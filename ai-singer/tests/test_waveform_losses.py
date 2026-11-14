from __future__ import annotations

import unittest

try:
    import torch
except ImportError:
    torch = None

from waveform_losses import waveform_reconstruction_losses


@unittest.skipIf(torch is None, "optional PyTorch training dependency is not installed")
class WaveformLossTests(unittest.TestCase):
    def test_losses_are_finite_and_backpropagate(self):
        target = torch.sin(torch.linspace(0, 30, 4096)).unsqueeze(0)
        prediction = (target * 0.8).detach().requires_grad_(True)
        mask = torch.ones_like(target)
        losses = waveform_reconstruction_losses(prediction, target, mask)
        self.assertTrue(torch.isfinite(losses["total"]))
        self.assertGreater(float(losses["total"].detach()), 0)
        losses["total"].backward()
        self.assertIsNotNone(prediction.grad)
        self.assertTrue(torch.isfinite(prediction.grad).all())

    def test_masked_tail_does_not_change_reconstruction_loss(self):
        target = torch.randn(1, 4096)
        mask = torch.ones_like(target)
        mask[:, 3072:] = 0
        first = target.clone()
        second = target.clone()
        first[:, 3072:] = 4.0
        second[:, 3072:] = -4.0
        a = waveform_reconstruction_losses(first, target, mask)
        b = waveform_reconstruction_losses(second, target, mask)
        self.assertTrue(torch.allclose(a["total"], b["total"], atol=1e-6, rtol=1e-6))

    def test_rejects_short_audio_for_all_resolutions(self):
        audio = torch.zeros(1, 128)
        with self.assertRaisesRegex(ValueError, "too short"):
            waveform_reconstruction_losses(audio, audio, torch.ones_like(audio))

    def test_rejects_empty_sample_mask(self):
        audio = torch.zeros(1, 2048)
        with self.assertRaisesRegex(ValueError, "at least one"):
            waveform_reconstruction_losses(audio, audio, torch.zeros_like(audio))


if __name__ == "__main__":
    unittest.main()
