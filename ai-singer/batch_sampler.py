"""Deterministic, length-aware batch planning for local SVS training.

This module only plans index groups. It does not train or infer.
"""
from __future__ import annotations

import random
from typing import Sequence

from batch_collator import TrainingExample


def make_training_batches(
    examples: Sequence[TrainingExample],
    *,
    batch_size: int,
    seed: int,
    epoch: int = 0,
    bucket_multiplier: int = 20,
    drop_last: bool = False,
) -> list[list[int]]:
    """Return deterministic shuffled batches with similar lengths grouped together.

    Indices refer to the input sequence. Every example appears exactly once
    unless drop_last=True, in which case only the final incomplete batch drops.
    Different epochs use different deterministic permutations.
    """
    if not examples:
        raise ValueError("examples must not be empty")
    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size < 1:
        raise ValueError("batch_size must be a positive integer")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("seed must be an integer")
    if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch < 0:
        raise ValueError("epoch must be a non-negative integer")
    if (isinstance(bucket_multiplier, bool) or not isinstance(bucket_multiplier, int)
            or bucket_multiplier < 1):
        raise ValueError("bucket_multiplier must be a positive integer")

    recording_ids = [example.recording_id for example in examples]
    if any(not isinstance(value, str) or not value.strip() for value in recording_ids):
        raise ValueError("every example must have a non-empty recording_id")
    if len(set(recording_ids)) != len(recording_ids):
        raise ValueError("recording_id values must be unique")

    lengths = []
    for example in examples:
        frames = len(example.acoustic.f0_hz)
        if frames < 1:
            raise ValueError("every example must contain at least one frame")
        lengths.append(frames)

    rng = random.Random((seed << 32) ^ epoch)
    indices = list(range(len(examples)))
    rng.shuffle(indices)

    bucket_size = batch_size * bucket_multiplier
    batches = []
    for start in range(0, len(indices), bucket_size):
        bucket = indices[start:start + bucket_size]
        bucket.sort(key=lambda index: lengths[index])
        for offset in range(0, len(bucket), batch_size):
            batch = bucket[offset:offset + batch_size]
            if len(batch) == batch_size or not drop_last:
                batches.append(batch)

    rng.shuffle(batches)
    return batches
