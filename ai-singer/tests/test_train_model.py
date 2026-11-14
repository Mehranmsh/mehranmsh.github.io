from __future__ import annotations

import unittest

from train_model import _acoustic_config
from batch_sampler import make_training_batches
from types import SimpleNamespace
import numpy as np


class TrainingCliPreparationTests(unittest.TestCase):
    def test_acoustic_config_matches_persian_inventory_and_requested_bins(self):
        config = _acoustic_config(48000, 256, 100)
        self.assertEqual(config.language, "fa")
        self.assertEqual(config.sample_rate, 48000)
        self.assertEqual(config.mel_bins, 100)

    def test_acoustic_config_respects_nyquist_at_22050(self):
        config = _acoustic_config(22050, 256, 80)
        self.assertLessEqual(config.f_max_hz, config.sample_rate / 2)

    def test_training_batch_plan_keeps_all_indices(self):
        examples = [
            SimpleNamespace(recording_id=f"r-{i}", acoustic=SimpleNamespace(f0_hz=np.zeros(i + 10)))
            for i in range(5)
        ]
        batches = make_training_batches(examples, batch_size=2, seed=7, epoch=0)
        flattened = [index for batch in batches for index in batch]
        self.assertEqual(sorted(flattened), list(range(5)))


if __name__ == "__main__":
    unittest.main()
