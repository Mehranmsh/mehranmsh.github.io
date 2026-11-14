"""Objective, privacy-safe quality metrics for held-out MEHRAN singing outputs.

This module compares in-memory arrays only. It does not load, upload, or log audio.
"""
from __future__ import annotations

import math
import numpy as np


class QualityEvaluationError(ValueError):
    """Invalid or incompatible evaluation inputs."""


def _track(name, value, *, ndim=1):
    array = np.asarray(value, dtype=np.float64)
    if array.ndim != ndim or array.size == 0:
        raise QualityEvaluationError(f"{name} must be a non-empty {ndim}-D array")
    if not np.isfinite(array).all():
        raise QualityEvaluationError(f"{name} must contain only finite values")
    return array


def _masked_mean(values, mask):
    selected = values[mask]
    if selected.size == 0:
        return None
    return float(np.mean(selected))


def _frames(signal: np.ndarray, size: int, hop: int) -> np.ndarray:
    if signal.size < size:
        signal = np.pad(signal, (0, size - signal.size))
    count = 1 + (signal.size - size) // hop
    shape = (count, size)
    strides = (signal.strides[0] * hop, signal.strides[0])
    return np.lib.stride_tricks.as_strided(signal, shape=shape, strides=strides)


def _spectral_metrics(reference: np.ndarray, generated: np.ndarray, fft_size: int) -> tuple[float, float]:
    hop = max(1, fft_size // 4)
    window = np.hanning(fft_size)
    ref_spec = np.abs(np.fft.rfft(_frames(reference, fft_size, hop) * window, axis=1))
    gen_spec = np.abs(np.fft.rfft(_frames(generated, fft_size, hop) * window, axis=1))
    ref_norm = float(np.linalg.norm(ref_spec))
    convergence = float(np.linalg.norm(ref_spec - gen_spec) / max(ref_norm, 1e-12))
    log_error = float(np.mean(np.abs(np.log(np.maximum(ref_spec, 1e-7)) -
                                     np.log(np.maximum(gen_spec, 1e-7)))))
    return convergence, log_error


def evaluate_singing_output(
    *,
    reference_waveform,
    generated_waveform,
    reference_f0_hz,
    generated_f0_hz,
    reference_voicing,
    generated_voicing,
    reference_log_mel,
    generated_log_mel,
    reference_log_rms,
    generated_log_rms,
    sample_rate: int,
    hop_length: int,
    spectral_fft_sizes: tuple[int, ...] = (512, 1024, 2048),
) -> dict:
    """Return aggregate objective metrics for one held-out paired example."""
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or sample_rate <= 0:
        raise QualityEvaluationError("sample_rate must be a positive integer")
    if isinstance(hop_length, bool) or not isinstance(hop_length, int) or hop_length <= 0:
        raise QualityEvaluationError("hop_length must be a positive integer")
    ref_wav = _track("reference_waveform", reference_waveform)
    gen_wav = _track("generated_waveform", generated_waveform)
    if ref_wav.shape != gen_wav.shape:
        raise QualityEvaluationError("reference and generated waveforms must have identical lengths")
    if np.max(np.abs(ref_wav)) > 1.0 or np.max(np.abs(gen_wav)) > 1.0:
        raise QualityEvaluationError("waveforms must be normalized to [-1, 1]")

    ref_f0 = _track("reference_f0_hz", reference_f0_hz)
    gen_f0 = _track("generated_f0_hz", generated_f0_hz)
    ref_voice = _track("reference_voicing", reference_voicing) > 0.5
    gen_voice = _track("generated_voicing", generated_voicing) > 0.5
    ref_energy = _track("reference_log_rms", reference_log_rms)
    gen_energy = _track("generated_log_rms", generated_log_rms)
    ref_mel = _track("reference_log_mel", reference_log_mel, ndim=2)
    gen_mel = _track("generated_log_mel", generated_log_mel, ndim=2)
    frame_shapes = {x.shape for x in (ref_f0, gen_f0, ref_voice, gen_voice, ref_energy, gen_energy)}
    if len(frame_shapes) != 1 or ref_mel.shape != gen_mel.shape or ref_mel.shape[0] != ref_f0.size:
        raise QualityEvaluationError("all acoustic feature tracks must be frame-aligned")
    if np.any(ref_f0 < 0) or np.any(gen_f0 < 0):
        raise QualityEvaluationError("F0 tracks cannot contain negative frequencies")
    if not np.any(ref_voice):
        raise QualityEvaluationError("reference must contain voiced frames")
    if not spectral_fft_sizes or any(
        isinstance(size, bool) or not isinstance(size, int) or size < 16 for size in spectral_fft_sizes
    ):
        raise QualityEvaluationError("spectral_fft_sizes must contain integers >= 16")

    voiced_overlap = ref_voice & gen_voice & (ref_f0 > 0) & (gen_f0 > 0)
    cents = np.zeros_like(ref_f0)
    cents[voiced_overlap] = 1200.0 * np.log2(gen_f0[voiced_overlap] / ref_f0[voiced_overlap])
    tp = int(np.sum(ref_voice & gen_voice))
    fp = int(np.sum(~ref_voice & gen_voice))
    fn = int(np.sum(ref_voice & ~gen_voice))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0

    spectral = [_spectral_metrics(ref_wav, gen_wav, size) for size in spectral_fft_sizes]
    rms = float(np.sqrt(np.mean(ref_wav ** 2)))
    error_rms = float(np.sqrt(np.mean((ref_wav - gen_wav) ** 2)))
    snr = 20.0 * math.log10(max(rms, 1e-12) / max(error_rms, 1e-12))
    return {
        "schema_version": "mehran.svs.quality-report.v1",
        "sample_rate": sample_rate,
        "hop_length": hop_length,
        "duration_seconds": round(ref_wav.size / sample_rate, 4),
        "frames_evaluated": int(ref_f0.size),
        "voiced_frames_reference": int(np.sum(ref_voice)),
        "voiced_frame_precision": precision,
        "voiced_frame_recall": recall,
        "voiced_frame_f1": f1,
        "f0_cents_rmse": _masked_mean(cents ** 2, voiced_overlap) ** 0.5
            if np.any(voiced_overlap) else None,
        "f0_voiced_frame_coverage": float(np.mean(voiced_overlap) / max(np.mean(ref_voice), 1e-12)),
        "log_mel_mae": float(np.mean(np.abs(ref_mel - gen_mel))),
        "log_rms_mae": float(np.mean(np.abs(ref_energy - gen_energy))),
        "waveform_snr_db": snr,
        "multi_resolution_spectral_convergence": float(np.mean([x[0] for x in spectral])),
        "multi_resolution_log_magnitude_mae": float(np.mean([x[1] for x in spectral])),
        "peak_amplitude": float(np.max(np.abs(gen_wav))),
        "clipped_sample_fraction": float(np.mean(np.abs(gen_wav) >= 0.999)),
        "quality_passed": False,
        "quality_thresholds_configured": False,
        "note": "Objective metrics only; human listening review is still required.",
    }
