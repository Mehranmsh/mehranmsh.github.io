"""Masked waveform and multi-resolution STFT losses for MEHRAN's local decoder training."""
from __future__ import annotations

import math
from typing import Sequence


def _torch():
    try:
        import torch
    except ImportError as exc:
        raise RuntimeError("Install ai-singer/training-requirements.txt to use waveform losses") from exc
    return torch


def waveform_reconstruction_losses(
    prediction,
    target,
    sample_mask,
    *,
    stft_sizes: Sequence[int] = (512, 1024, 2048),
    waveform_l1_weight: float = 1.0,
    spectral_convergence_weight: float = 1.0,
    log_magnitude_weight: float = 1.0,
) -> dict[str, object]:
    """Return sample-masked L1 and multi-resolution STFT losses.

    STFT frames are included only when every sample in the frame is valid.
    This prevents reflected tail padding and batch padding from leaking into
    spectral targets. Input tensors use shape (batch, samples).
    """
    torch = _torch()
    if prediction.ndim != 2 or target.ndim != 2 or sample_mask.ndim != 2:
        raise ValueError("waveform prediction, target, and mask must have shape (batch, samples)")
    if prediction.shape != target.shape or prediction.shape != sample_mask.shape:
        raise ValueError("waveform prediction, target, and mask shapes must match")
    if not torch.isfinite(prediction).all() or not torch.isfinite(target).all():
        raise ValueError("waveform tensors must contain finite values")
    if not torch.isfinite(sample_mask).all() or torch.any((sample_mask < 0) | (sample_mask > 1)):
        raise ValueError("sample mask must be finite and between zero and one")
    if torch.any(sample_mask.sum(dim=1) <= 0):
        raise ValueError("each waveform needs at least one valid sample")
    if not stft_sizes or any(isinstance(n, bool) or not isinstance(n, int) or n < 16 for n in stft_sizes):
        raise ValueError("stft_sizes must contain integers of at least 16 samples")
    for name, weight in (
        ("waveform_l1_weight", waveform_l1_weight),
        ("spectral_convergence_weight", spectral_convergence_weight),
        ("log_magnitude_weight", log_magnitude_weight),
    ):
        if not math.isfinite(weight) or weight < 0:
            raise ValueError(f"{name} must be finite and non-negative")
    if waveform_l1_weight + spectral_convergence_weight + log_magnitude_weight <= 0:
        raise ValueError("at least one waveform loss weight must be positive")

    mask = sample_mask.to(dtype=prediction.dtype)
    waveform_l1 = (torch.abs(prediction - target) * mask).sum() / mask.sum().clamp_min(1.0)

    convergence_terms = []
    log_magnitude_terms = []
    sample_count = prediction.shape[1]
    for n_fft in stft_sizes:
        if n_fft > sample_count:
            continue
        hop = max(1, n_fft // 4)
        window = torch.hann_window(n_fft, device=prediction.device, dtype=prediction.dtype)
        pred_spec = torch.stft(
            prediction, n_fft=n_fft, hop_length=hop, win_length=n_fft,
            window=window, center=False, return_complex=True,
        ).abs()
        target_spec = torch.stft(
            target, n_fft=n_fft, hop_length=hop, win_length=n_fft,
            window=window, center=False, return_complex=True,
        ).abs()
        frame_mask = mask.unfold(1, n_fft, hop).amin(dim=-1)
        spectral_mask = frame_mask.unsqueeze(1)
        valid_bins = spectral_mask.sum(dim=(1, 2)) * pred_spec.shape[1]
        active_rows = valid_bins > 0
        if not torch.any(active_rows):
            continue
        diff = (pred_spec - target_spec) * spectral_mask
        reference = target_spec * spectral_mask
        numerator = torch.sqrt(diff.square().sum(dim=(1, 2)) + 1e-8)
        denominator = torch.sqrt(reference.square().sum(dim=(1, 2)) + 1e-8)
        convergence_terms.append((numerator[active_rows] / denominator[active_rows].clamp_min(1e-5)).mean())
        log_diff = torch.abs(
            torch.log(pred_spec.clamp_min(1e-5)) - torch.log(target_spec.clamp_min(1e-5))
        ) * spectral_mask
        log_magnitude_terms.append(
            log_diff.sum() / (spectral_mask.sum() * pred_spec.shape[1]).clamp_min(1.0)
        )

    if not convergence_terms:
        raise ValueError("waveform is too short for every configured STFT resolution")
    spectral_convergence = torch.stack(convergence_terms).mean()
    log_magnitude = torch.stack(log_magnitude_terms).mean()
    total = (
        waveform_l1_weight * waveform_l1
        + spectral_convergence_weight * spectral_convergence
        + log_magnitude_weight * log_magnitude
    )
    return {
        "total": total,
        "waveform_l1": waveform_l1,
        "spectral_convergence": spectral_convergence,
        "log_magnitude": log_magnitude,
    }
