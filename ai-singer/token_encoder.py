"""Frame-aligned phoneme and note token encoding for the Persian SVS model.

This is a deterministic conditioning encoder, not a trained model or synthesizer.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from acoustic_contract import AcousticConditioning
from model_config import AcousticModelConfig
from phoneme_inventory import PHONEME_FEATURES, canonicalize_phoneme


# ID 0 is reserved for silence/unvoiced frames. Remaining IDs are stable
# for a given phoneme inventory version because the symbols are sorted.
PHONEME_TO_ID = {
    symbol: index + 1
    for index, symbol in enumerate(sorted(PHONEME_FEATURES))
}


@dataclass(frozen=True)
class FrameTokenSequence:
    frame_times_seconds: np.ndarray
    phoneme_ids: np.ndarray
    note_ids: np.ndarray
    phoneme_mask: np.ndarray
    note_mask: np.ndarray
    phoneme_vocabulary_version: str
    frame_rate_hz: float


def build_frame_token_sequence(
    conditioning: AcousticConditioning,
    config: AcousticModelConfig,
) -> FrameTokenSequence:
    """Encode reviewed Persian phonemes and monophonic notes at frame centers.

    Token 0 means no active phoneme/note. Note tokens are MIDI pitch + 1,
    leaving 0 available for rests. Phoneme IDs are tied to the inventory
    version and must not be reused with a different vocabulary.
    """
    if conditioning.language != "fa" or config.language != "fa":
        raise ValueError("frame token encoder currently supports Persian (fa) only")
    if conditioning.sample_rate != config.sample_rate:
        raise ValueError("conditioning and model config sample rates must match")

    hop = config.hop_length
    frame_count = int(np.floor(conditioning.duration_seconds * config.sample_rate / hop)) + 1
    frame_times = np.arange(frame_count, dtype=np.float64) * hop / config.sample_rate
    frame_times = frame_times[frame_times <= conditioning.duration_seconds + 1e-9]

    phoneme_ids = np.zeros(frame_times.shape, dtype=np.int32)
    note_ids = np.zeros(frame_times.shape, dtype=np.int32)

    for span in conditioning.phonemes:
        symbol = canonicalize_phoneme(span.phoneme)
        token = PHONEME_TO_ID.get(symbol)
        if token is None:
            raise ValueError(f"phoneme is not in configured vocabulary: {symbol}")
        active = (frame_times >= span.start_seconds) & (frame_times < span.end_seconds)
        if np.any(phoneme_ids[active] != 0):
            raise ValueError("phoneme spans overlap at feature-frame centers")
        phoneme_ids[active] = token

    ordered_notes = sorted(conditioning.notes, key=lambda item: item.start_seconds)
    previous_end = -1.0
    for note in ordered_notes:
        start = note.start_seconds
        end = start + note.duration_seconds
        if start < previous_end - 1e-9:
            raise ValueError("frame token encoder requires a monophonic note line")
        previous_end = end
        active = (frame_times >= start) & (frame_times < end)
        if np.any(note_ids[active] != 0):
            raise ValueError("note events overlap at feature-frame centers")
        note_ids[active] = note.midi_note + 1

    return FrameTokenSequence(
        frame_times_seconds=frame_times,
        phoneme_ids=phoneme_ids,
        note_ids=note_ids,
        phoneme_mask=(phoneme_ids != 0).astype(np.uint8),
        note_mask=(note_ids != 0).astype(np.uint8),
        phoneme_vocabulary_version=config.phoneme_inventory_version,
        frame_rate_hz=config.frame_rate_hz,
    )
