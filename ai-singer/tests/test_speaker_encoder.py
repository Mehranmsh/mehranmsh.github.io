from __future__ import annotations

import importlib.util
import unittest


@unittest.skipUnless(importlib.util.find_spec("torch"), "optional PyTorch dependency is not installed")
class ReferenceSpeakerEncoderTests(unittest.TestCase):
    def test_returns_normalized_embedding_and_backpropagates(self):
        import torch
        from speaker_encoder import build_speaker_encoder

        model = build_speaker_encoder(mel_bins=40, embedding_size=32)
        mel = torch.randn(2, 17, 40)
        mask = torch.ones(2, 17, dtype=torch.bool)
        mask[1, 12:] = False
        result = model(mel, mask)
        self.assertEqual(tuple(result.shape), (2, 32))
        self.assertTrue(torch.allclose(result.norm(dim=-1), torch.ones(2), atol=1e-5))
        result.square().sum().backward()
        self.assertIsNotNone(model.projection[-1].weight.grad)
        self.assertTrue(torch.isfinite(model.projection[-1].weight.grad).all())

    def test_rejects_empty_reference_and_bad_dimensions(self):
        import torch
        from speaker_encoder import build_speaker_encoder

        model = build_speaker_encoder(mel_bins=40, embedding_size=32)
        with self.assertRaisesRegex(ValueError, "at least one valid frame"):
            model(torch.zeros(1, 4, 40), torch.zeros(1, 4, dtype=torch.bool))
        with self.assertRaisesRegex(ValueError, "dimensions must match"):
            model(torch.zeros(1, 4, 40), torch.ones(1, 3, dtype=torch.bool))
        with self.assertRaisesRegex(ValueError, "mel dimension"):
            model(torch.zeros(1, 4, 39), torch.ones(1, 4, dtype=torch.bool))

    def test_padding_is_excluded_from_pooling(self):
        import torch
        from speaker_encoder import build_speaker_encoder

        torch.manual_seed(17)
        model = build_speaker_encoder(mel_bins=40, embedding_size=32).eval()
        valid = torch.randn(1, 9, 40)
        short = model(valid, torch.ones(1, 9, dtype=torch.bool))
        padded = torch.cat((valid, torch.randn(1, 7, 40)), dim=1)
        mask = torch.cat((torch.ones(1, 9), torch.zeros(1, 7)), dim=1).bool()
        long = model(padded, mask)
        self.assertTrue(torch.allclose(short, long, atol=1e-5, rtol=1e-5))


if __name__ == "__main__":
    unittest.main()
