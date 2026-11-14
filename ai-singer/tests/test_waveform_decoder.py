from __future__ import annotations

import importlib.util
import unittest

from waveform_decoder import WaveformDecoderConfig, build_waveform_decoder


class WaveformDecoderConfigTests(unittest.TestCase):
    def test_default_upsampling_matches_hop_length(self):
        self.assertEqual(WaveformDecoderConfig().validate().hop_length, 256)

    def test_rejects_mismatched_upsampling_ratio(self):
        with self.assertRaisesRegex(ValueError, "product"):
            WaveformDecoderConfig(hop_length=320).validate()

    def test_rejects_invalid_channel_width(self):
        with self.assertRaisesRegex(ValueError, "divisible"):
            WaveformDecoderConfig(initial_channels=250).validate()


@unittest.skipUnless(importlib.util.find_spec("torch"), "optional PyTorch dependency is not installed")
class WaveformDecoderForwardTests(unittest.TestCase):
    def test_generates_expected_sample_count_and_backpropagates(self):
        import torch

        cfg = WaveformDecoderConfig(
            mel_bins=8, hop_length=16, upsample_factors=(4, 4),
            initial_channels=64, residual_dilations=(1, 2),
            speaker_embedding_size=32,
        )
        model = build_waveform_decoder(cfg)
        batch, frames, reference_frames = 2, 7, 9
        mel = torch.randn(batch, frames, cfg.mel_bins)
        f0 = torch.full((batch, frames), 220.0)
        voicing = torch.ones(batch, frames)
        energy = torch.zeros(batch, frames)
        reference = torch.randn(batch, reference_frames, cfg.mel_bins)
        reference_mask = torch.ones(batch, reference_frames, dtype=torch.bool)
        reference_mask[1, 6:] = False

        waveform = model(mel, f0, voicing, energy, reference, reference_mask)
        self.assertEqual(tuple(waveform.shape), (batch, frames * cfg.hop_length))
        self.assertTrue(torch.isfinite(waveform).all())
        self.assertLessEqual(float(waveform.abs().max()), 1.0)
        waveform.square().mean().backward()
        self.assertIsNotNone(model.condition_projection.weight.grad)
        self.assertIsNotNone(model.speaker_encoder.frontend[0].weight.grad)
        self.assertTrue(torch.isfinite(model.condition_projection.weight.grad).all())

    def test_requires_reference_voice(self):
        import torch

        cfg = WaveformDecoderConfig(
            mel_bins=8, hop_length=16, upsample_factors=(4, 4),
            initial_channels=64, residual_dilations=(1,), speaker_embedding_size=32,
        )
        model = build_waveform_decoder(cfg)
        mel = torch.zeros(1, 2, 8)
        track = torch.zeros(1, 2)
        with self.assertRaisesRegex(ValueError, "separate speaker reference"):
            model(mel, track, track, track, None, None)


if __name__ == "__main__":
    unittest.main()
