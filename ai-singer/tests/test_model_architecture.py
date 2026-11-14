from __future__ import annotations

import importlib.util
import unittest

from model_architecture import SingingNetworkConfig, build_singing_model


class SingingNetworkConfigTests(unittest.TestCase):
    def test_default_config_matches_persian_inventory(self):
        cfg = SingingNetworkConfig().validate()
        self.assertEqual(cfg.note_vocab_size, 129)
        self.assertEqual(cfg.phoneme_vocab_size, 32)

    def test_rejects_non_divisible_attention_width(self):
        with self.assertRaisesRegex(ValueError, "divisible"):
            SingingNetworkConfig(hidden_size=190, attention_heads=4).validate()

    def test_rejects_wrong_phoneme_vocabulary_size(self):
        with self.assertRaisesRegex(ValueError, "installed inventory"):
            SingingNetworkConfig(phoneme_vocab_size=99).validate()


@unittest.skipUnless(importlib.util.find_spec("torch"), "optional PyTorch training dependency is not installed")
class SingingNetworkForwardTests(unittest.TestCase):
    def test_reference_audio_conditions_network_and_receives_gradients(self):
        import torch

        model = build_singing_model(SingingNetworkConfig(
            hidden_size=32, attention_heads=4, encoder_layers=1,
            convolution_layers=1, feedforward_size=64, dropout=0.0,
        ))
        model.eval()
        batch, frames, ref_frames = 2, 8, 11
        phonemes = torch.ones((batch, frames), dtype=torch.long)
        notes = torch.full((batch, frames), 60, dtype=torch.long)
        f0 = torch.full((batch, frames), 220.0)
        voice = torch.ones((batch, frames))
        energy = torch.zeros((batch, frames))
        valid = torch.ones((batch, frames), dtype=torch.bool)
        reference = torch.randn(batch, ref_frames, 100)
        reference_mask = torch.ones(batch, ref_frames, dtype=torch.bool)
        reference_mask[1, 8:] = False
        output = model(phonemes, notes, f0, voice, energy, valid, reference, reference_mask)
        loss = output["log_mel"].square().mean()
        loss.backward()
        self.assertIsNotNone(model.speaker_encoder.frontend[0].weight.grad)
        self.assertTrue(torch.isfinite(model.speaker_encoder.frontend[0].weight.grad).all())

    def test_forward_shapes_masks_and_gradients(self):
        import torch

        model = build_singing_model(SingingNetworkConfig(
            hidden_size=32,
            attention_heads=4,
            encoder_layers=1,
            convolution_layers=1,
            feedforward_size=64,
            dropout=0.0,
        ))
        model.train()
        batch, frames = 2, 12
        valid = torch.ones((batch, frames), dtype=torch.bool)
        valid[1, 9:] = False
        phonemes = torch.ones((batch, frames), dtype=torch.long)
        notes = torch.full((batch, frames), 60, dtype=torch.long)
        f0 = torch.full((batch, frames), 261.6)
        voice = torch.ones((batch, frames))
        energy = torch.zeros((batch, frames))
        output = model(phonemes, notes, f0, voice, energy, valid)

        self.assertEqual(tuple(output["log_mel"].shape), (batch, frames, 100))
        for key in ("f0_hz", "voicing_logits", "log_rms"):
            self.assertEqual(tuple(output[key].shape), (batch, frames))
        self.assertTrue(torch.equal(output["log_mel"][1, 9:], torch.zeros_like(output["log_mel"][1, 9:])))
        loss = output["log_mel"].square().mean() + output["f0_hz"].mean()
        loss.backward()
        self.assertIsNotNone(model.mel_head.weight.grad)
        self.assertTrue(torch.isfinite(model.mel_head.weight.grad).all())


if __name__ == "__main__":
    unittest.main()
