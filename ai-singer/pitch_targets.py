"""Frame-aligned MIDI pitch targets for a monophonic singing voice.

These are conditioning targets for training/inference research, not rendered audio.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from acoustic_contract import AcousticConditioning
from model_config import AcousticModelConfig


@dataclass(frozen=True)
class PitchTargets:
    frame_times_seconds: np.ndarray
    f0_hz: np.ndarray
    voicing_mask: np.ndarray
    energy: np.ndarray


def build_pitch_targets(
    conditioning: AcousticConditioning,
    config: AcousticModelConfig,
    *,
    vibrato_onset_seconds: float = 0.15,
    vibrato_fade_seconds: float = 0.10,
) -> PitchTargets:
    """Convert a reviewed monophonic MIDI line into deterministic frame targets.

    Frame centers follow the centered-STFT convention: t = frame * hop / rate.
    Vibrato depth is capped at one semitone and fades in after the onset delay.
    """
    if conditioning.sample_rate != config.sample_rate:
        raise ValueError("conditioning sample rate does not match acoustic model config")
    if conditioning.language != config.language:
        raise ValueError("conditioning language does not match acoustic model config")
    if vibrato_onset_seconds < 0 or vibrato_fade_seconds <= 0:
        raise ValueError("vibrato onset must be non-negative and fade must be positive")

    ordered = sorted(conditioning.notes, key=lambda note: note.start_seconds)
    previous_end = -1.0
    for note in ordered:
        if note.start_seconds < previous_end - 1e-9:
            raise ValueError("singing pitch targets require a monophonic, non-overlapping note line")
        previous_end = note.start_seconds + note.duration_seconds

    frame_count = int(np.floor(
        conditioning.duration_seconds * config.sample_rate / config.hop_length
    )) + 1
    times = np.arange(frame_count, dtype=np.float64) * (
        config.hop_length / config.sample_rate
    )
    f0 = np.zeros(frame_count, dtype=np.float32)
    voiced = np.zeros(frame_count, dtype=np.float32)
    energy = np.zeros(frame_count, dtype=np.float32)

    style = conditioning.style
    for note in ordered:
        end = note.start_seconds + note.duration_seconds
        active = (times >= note.start_seconds) & (times < end)
        if not np.any(active):
            continue
        local_time = times[active] - note.start_seconds
        vibrato_age = np.maximum(local_time - vibrato_onset_seconds, 0.0)
        fade = np.clip(vibrato_age / vibrato_fade_seconds, 0.0, 1.0)
        depth_semitones = style.vibrato_depth * fade
        vibrato = depth_semitones * np.sin(
            2.0 * np.pi * style.vibrato_rate_hz * vibrato_age
        )
        semitones = note.midi_note - 69 + style.pitch_shift_semitones + vibrato
        f0[active] = (440.0 * np.power(2.0, semitones / 12.0)).astype(np.float32)
        voiced[active] = 1.0
        energy[active] = style.energy * (note.velocity / 127.0)

    return PitchTargets(
        frame_times_seconds=times.astype(np.float32),
        f0_hz=f0,
        voicing_mask=voiced,
        energy=energy,
    )
