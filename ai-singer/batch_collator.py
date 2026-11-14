"""Padded NumPy batch collation for MEHRAN SVS training examples.

This prepares aligned arrays for a future trainer. It does not train or infer.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Sequence

import numpy as np

from model_config import AcousticModelConfig
from signal_features import AcousticFeatures
from token_encoder import FrameTokenSequence, PHONEME_TO_ID
from pitch_targets import PitchTargets


@dataclass(frozen=True)
class TrainingExample:
    recording_id: str
    acoustic: AcousticFeatures
    tokens: FrameTokenSequence
    pitch_targets: PitchTargets
    speaker_reference_log_mel: np.ndarray | None = None


@dataclass(frozen=True)
class TrainingBatch:
    recording_ids: tuple[str, ...]
    lengths: np.ndarray
    valid_frame_mask: np.ndarray
    phoneme_ids: np.ndarray
    note_ids: np.ndarray
    phoneme_mask: np.ndarray
    note_mask: np.ndarray
    conditioning_f0_hz: np.ndarray
    conditioning_voicing_mask: np.ndarray
    conditioning_energy: np.ndarray
    target_log_mel: np.ndarray
    target_f0_hz: np.ndarray
    target_voicing_mask: np.ndarray
    target_log_rms: np.ndarray
    sample_rate: int
    hop_length: int
    speaker_reference_log_mel: np.ndarray | None = None
    speaker_reference_frame_mask: np.ndarray | None = None


def collate_training_examples(
    examples: Sequence[TrainingExample],
    config: AcousticModelConfig,
    *,
    pad_to_multiple_of: int = 1,
    max_frames: int = 120_000,
) -> TrainingBatch:
    """Validate alignment, then right-pad a batch to a shared frame length."""
    if not examples:
        raise ValueError("training batch must contain at least one example")
    if pad_to_multiple_of < 1:
        raise ValueError("pad_to_multiple_of must be positive")
    if max_frames < 1:
        raise ValueError("max_frames must be positive")

    checked = []
    seen_recording_ids = set()
    for example in examples:
        if not isinstance(example.recording_id, str) or not example.recording_id.strip():
            raise ValueError("each example requires a recording_id")
        if example.recording_id in seen_recording_ids:
            raise ValueError("recording_id values must be unique within a batch")
        seen_recording_ids.add(example.recording_id)

        acoustic, tokens, pitch = example.acoustic, example.tokens, example.pitch_targets
        if acoustic.sample_rate != config.sample_rate or tokens.phoneme_vocabulary_version != config.phoneme_inventory_version:
            raise ValueError("example feature rate or phoneme vocabulary does not match model config")
        if acoustic.hop_length != config.hop_length:
            raise ValueError("example hop length does not match model config")
        if acoustic.log_mel.ndim != 2 or acoustic.log_mel.shape[1] != config.mel_bins:
            raise ValueError("log_mel must have shape (frames, configured mel_bins)")
        frame_count = acoustic.log_mel.shape[0]
        arrays = [
            acoustic.f0_hz, acoustic.voicing_mask, acoustic.log_rms,
            tokens.frame_times_seconds, tokens.phoneme_ids, tokens.note_ids,
            tokens.phoneme_mask, tokens.note_mask,
            pitch.frame_times_seconds, pitch.f0_hz, pitch.voicing_mask, pitch.energy,
        ]
        if frame_count <= 0 or any(np.asarray(array).ndim != 1 or len(array) != frame_count for array in arrays):
            raise ValueError("all feature, token, and pitch tracks must share one non-empty frame axis")

        expected_times = np.arange(frame_count, dtype=np.float64) * config.hop_length / config.sample_rate
        if not np.allclose(tokens.frame_times_seconds, expected_times, atol=1e-6, rtol=0):
            raise ValueError("token frame times do not match centered feature-frame grid")
        if not np.allclose(pitch.frame_times_seconds, expected_times, atol=1e-6, rtol=0):
            raise ValueError("pitch target frame times do not match centered feature-frame grid")

        if (np.any(tokens.phoneme_ids < 0) or np.any(tokens.phoneme_ids > len(PHONEME_TO_ID))
                or np.any(tokens.note_ids < 0) or np.any(tokens.note_ids > 128)):
            raise ValueError("token IDs are outside supported ranges")
        if not np.isin(tokens.phoneme_mask, [0, 1]).all() or not np.isin(tokens.note_mask, [0, 1]).all():
            raise ValueError("token masks must contain only zero or one")
        if not np.array_equal(tokens.phoneme_mask.astype(bool), tokens.phoneme_ids != 0):
            raise ValueError("phoneme mask must exactly match nonzero phoneme IDs")
        if not np.array_equal(tokens.note_mask.astype(bool), tokens.note_ids != 0):
            raise ValueError("note mask must exactly match nonzero note IDs")

        if not np.isfinite(acoustic.log_mel).all() or not np.isfinite(acoustic.f0_hz).all() or not np.isfinite(acoustic.log_rms).all():
            raise ValueError("acoustic targets must contain finite values")
        if not np.isfinite(pitch.f0_hz).all() or not np.isfinite(pitch.energy).all():
            raise ValueError("pitch conditioning must contain finite values")
        if np.any(acoustic.f0_hz < 0) or np.any(pitch.f0_hz < 0) or np.any(pitch.energy < 0):
            raise ValueError("F0 and energy values cannot be negative")
        if not np.isin(acoustic.voicing_mask, [0, 1]).all() or not np.isin(pitch.voicing_mask, [0, 1]).all():
            raise ValueError("voicing masks must contain only zero or one")
        if not np.array_equal(acoustic.voicing_mask.astype(bool), acoustic.f0_hz > 0):
            raise ValueError("acoustic voicing mask must match positive target F0 values")
        if not np.array_equal(pitch.voicing_mask.astype(bool), pitch.f0_hz > 0):
            raise ValueError("conditioning voicing mask must match positive conditioning F0 values")
        reference = example.speaker_reference_log_mel
        if reference is not None:
            reference = np.asarray(reference)
            if reference.ndim != 2 or reference.shape[0] < 1 or reference.shape[1] != config.mel_bins:
                raise ValueError("speaker reference must have shape (non-empty frames, configured mel_bins)")
            if not np.isfinite(reference).all():
                raise ValueError("speaker reference features must contain finite values")
        checked.append((example, frame_count, reference))

    has_references = [reference is not None for _, _, reference in checked]
    if any(has_references) and not all(has_references):
        raise ValueError("all examples in a batch must provide speaker references or none may provide them")
    longest = max(length for _, length, _ in checked)
    padded_length = int(math.ceil(longest / pad_to_multiple_of) * pad_to_multiple_of)
    if padded_length > max_frames:
        raise ValueError("padded batch exceeds max_frames")

    batch_size = len(checked)
    reference_mel = None
    reference_mask = None
    if all(has_references):
        reference_frames = max(ref.shape[0] for _, _, ref in checked)
        reference_mel = np.full((batch_size, reference_frames, config.mel_bins), mel_pad, dtype=np.float32)
        reference_mask = np.zeros((batch_size, reference_frames), dtype=np.uint8)
    mel_pad = float(np.log(config.log_floor))
    mel = np.full((batch_size, padded_length, config.mel_bins), mel_pad, dtype=np.float32)
    phoneme = np.zeros((batch_size, padded_length), dtype=np.int32)
    note = np.zeros((batch_size, padded_length), dtype=np.int32)
    phoneme_mask = np.zeros((batch_size, padded_length), dtype=np.uint8)
    note_mask = np.zeros((batch_size, padded_length), dtype=np.uint8)
    cond_f0 = np.zeros((batch_size, padded_length), dtype=np.float32)
    cond_voice = np.zeros((batch_size, padded_length), dtype=np.uint8)
    cond_energy = np.zeros((batch_size, padded_length), dtype=np.float32)
    target_f0 = np.zeros((batch_size, padded_length), dtype=np.float32)
    target_voice = np.zeros((batch_size, padded_length), dtype=np.uint8)
    target_rms = np.zeros((batch_size, padded_length), dtype=np.float32)
    valid = np.zeros((batch_size, padded_length), dtype=np.uint8)
    lengths = np.zeros(batch_size, dtype=np.int32)

    for row, (example, length, reference) in enumerate(checked):
        a, t, p = example.acoustic, example.tokens, example.pitch_targets
        lengths[row] = length
        valid[row, :length] = 1
        mel[row, :length] = a.log_mel
        phoneme[row, :length] = t.phoneme_ids
        note[row, :length] = t.note_ids
        phoneme_mask[row, :length] = t.phoneme_mask.astype(np.uint8)
        note_mask[row, :length] = t.note_mask.astype(np.uint8)
        cond_f0[row, :length] = p.f0_hz
        cond_voice[row, :length] = p.voicing_mask.astype(np.uint8)
        cond_energy[row, :length] = p.energy
        target_f0[row, :length] = a.f0_hz
        target_voice[row, :length] = a.voicing_mask.astype(np.uint8)
        target_rms[row, :length] = a.log_rms
        if reference_mel is not None:
            reference_length = reference.shape[0]
            reference_mel[row, :reference_length] = reference
            reference_mask[row, :reference_length] = 1

    return TrainingBatch(
        recording_ids=tuple(example.recording_id for example, _, _ in checked),
        lengths=lengths,
        valid_frame_mask=valid,
        phoneme_ids=phoneme,
        note_ids=note,
        phoneme_mask=phoneme_mask,
        note_mask=note_mask,
        conditioning_f0_hz=cond_f0,
        conditioning_voicing_mask=cond_voice,
        conditioning_energy=cond_energy,
        target_log_mel=mel,
        target_f0_hz=target_f0,
        target_voicing_mask=target_voice,
        target_log_rms=target_rms,
        sample_rate=config.sample_rate,
        hop_length=config.hop_length,
        speaker_reference_log_mel=reference_mel,
        speaker_reference_frame_mask=reference_mask,
    )
