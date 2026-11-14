from __future__ import annotations

from types import SimpleNamespace
import unittest

import numpy as np

from batch_sampler import make_training_batches


def examples(lengths):
    return [
        SimpleNamespace(recording_id=f"rec-{index}", acoustic=SimpleNamespace(f0_hz=np.zeros(length)))
        for index, length in enumerate(lengths)
    ]


class BatchSamplerTests(unittest.TestCase):
    def test_is_deterministic_for_same_seed_and_epoch(self):
        data = examples([20, 10, 40, 30, 15, 25, 35])
        first = make_training_batches(data, batch_size=2, seed=123, epoch=4)
        second = make_training_batches(data, batch_size=2, seed=123, epoch=4)
        self.assertEqual(first, second)

    def test_different_epochs_change_order(self):
        data = examples([20, 10, 40, 30, 15, 25, 35, 45])
        first = make_training_batches(data, batch_size=2, seed=123, epoch=0)
        second = make_training_batches(data, batch_size=2, seed=123, epoch=1)
        self.assertNotEqual(first, second)

    def test_each_record_appears_once_without_drop_last(self):
        data = examples([20, 10, 40, 30, 15])
        batches = make_training_batches(data, batch_size=2, seed=9)
        flattened = [index for batch in batches for index in batch]
        self.assertEqual(sorted(flattened), list(range(len(data))))

    def test_drop_last_drops_only_incomplete_tail(self):
        data = examples([20, 10, 40, 30, 15])
        batches = make_training_batches(data, batch_size=2, seed=9, drop_last=True)
        self.assertEqual(len(batches), 2)
        self.assertTrue(all(len(batch) == 2 for batch in batches))

    def test_rejects_duplicate_recording_ids(self):
        data = examples([20, 10])
        data[1].recording_id = data[0].recording_id
        with self.assertRaisesRegex(ValueError, "unique"):
            make_training_batches(data, batch_size=2, seed=1)

    def test_rejects_invalid_batch_size(self):
        with self.assertRaisesRegex(ValueError, "batch_size"):
            make_training_batches(examples([10]), batch_size=0, seed=1)

    def test_rejects_empty_examples(self):
        with self.assertRaisesRegex(ValueError, "empty"):
            make_training_batches([], batch_size=2, seed=1)


if __name__ == "__main__":
    unittest.main()
