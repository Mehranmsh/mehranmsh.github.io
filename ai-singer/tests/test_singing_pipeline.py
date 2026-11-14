from __future__ import annotations

import unittest

try:
    import torch
except ImportError:
    torch = None

from model_architecture import SingingNetworkConfig
from waveform_decoder import WaveformDecoderConfig
from singing_pipeline import build_singing_pipeline


@unittest.skipIf(torch is None, "optional PyTorch training dependency is not installed")
class SingingPipelineTests(unittest.TestCase):
    def test_composes_acoustic_predictions_into_waveform(self):
        acoustic_cfg = SingingNetworkConfig(
            mel_bins=40, hidden_size=32, attention_heads=4,
            encoder_layers=1, convolution_layers=1, feedforward_size=64, dropout=0.0,
        )
        decoder_cfg = WaveformDecoderConfig(
            mel_bins=40, sample_rate=48000, hop_length=4, initial_channels=32,
            upsample_factors=(2, 2), residual_dilations=(1,), speaker_embedding_size=16,
        )
        pipeline = build_singing_pipeline(acoustic_cfg, decoder_cfg).eval()
        frames = 16
        phonemes = torch.ones((2, frames), dtype=torch.long)
        notes = torch.full((2, frames), 60, dtype=torch.long)
        f0 = torch.full((2, frames), 440.0)
        voice = torch.ones((2, frames))
        energy = torch.full((2, frames), -2.0)
        valid = torch.zeros((2, frames), dtype=torch.bool)
        valid[0, :] = True
        valid[1, :12] = True
        reference = torch.randn((2, 20, 40))
        reference_mask = torch.ones((2, 20), dtype=torch.bool)
        with torch.inference_mode():
            result = pipeline(
                phonemes, notes, f0, voice, energy, valid, reference, reference_mask
            )
        self.assertEqual(result["waveform"].shape, (2, frames * 4))
        self.assertEqual(result["waveform_sample_lengths"].tolist(), [64, 48])
        self.assertEqual(result["sample_rate"], 48000)
        self.assertTrue(torch.isfinite(result["waveform"]).all())
        self.assertLessEqual(float(result["waveform"].abs().max()), 1.0)

    def test_rejects_mel_contract_mismatch(self):
        acoustic_cfg = SingingNetworkConfig(mel_bins=40, hidden_size=32, attention_heads=4,
            encoder_layers=1, convolution_layers=1, feedforward_size=64)
        decoder_cfg = WaveformDecoderConfig(mel_bins=80)
        with self.assertRaisesRegex(ValueError, "mel_bins must match"):
            build_singing_pipeline(acoustic_cfg, decoder_cfg)


if __name__ == "__main__":
    unittest.main()
