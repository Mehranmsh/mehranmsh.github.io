"""Reference-audio speaker encoder for MEHRAN's local SVS model.

This module maps a separate reference recording to a normalized speaker vector.
It is a trainable component only: it does not identify a person, train itself,
or synthesize audio. Reference clips must be consented and split-safe.
"""
from __future__ import annotations


def build_speaker_encoder(mel_bins: int = 100, embedding_size: int = 192):
    """Build a masked log-Mel encoder returning one L2-normalized vector/sample."""
    if isinstance(mel_bins, bool) or not isinstance(mel_bins, int) or mel_bins < 1:
        raise ValueError("mel_bins must be a positive integer")
    if isinstance(embedding_size, bool) or not isinstance(embedding_size, int) or embedding_size < 16:
        raise ValueError("embedding_size must be an integer >= 16")
    try:
        import torch
        from torch import nn
        from torch.nn import functional as F
    except ImportError as exc:
        raise RuntimeError(
            "PyTorch is required only for model training; install ai-singer/training-requirements.txt"
        ) from exc

    class ReferenceSpeakerEncoder(nn.Module):
        def __init__(self):
            super().__init__()
            self.frontend = nn.ModuleList([
                nn.Conv1d(mel_bins, 128, kernel_size=5, padding=2),
                nn.Conv1d(128, 192, kernel_size=3, padding=1),
                nn.Conv1d(192, embedding_size, kernel_size=3, padding=1),
            ])
            self.projection = nn.Sequential(
                nn.Linear(embedding_size * 2, embedding_size),
                nn.GELU(),
                nn.Linear(embedding_size, embedding_size),
            )

        def forward(self, reference_log_mel, reference_frame_mask):
            if reference_log_mel.ndim != 3:
                raise ValueError("reference_log_mel must have shape (batch, frames, mel_bins)")
            if reference_frame_mask.ndim != 2:
                raise ValueError("reference_frame_mask must have shape (batch, frames)")
            if reference_log_mel.shape[:2] != reference_frame_mask.shape:
                raise ValueError("reference mel and mask batch/frame dimensions must match")
            if reference_log_mel.shape[2] != mel_bins:
                raise ValueError("reference mel dimension does not match mel_bins")
            if reference_log_mel.shape[1] < 1:
                raise ValueError("reference audio must contain at least one frame")
            if not torch.isfinite(reference_log_mel).all():
                raise ValueError("reference mel values must be finite")
            mask = reference_frame_mask.to(torch.bool)
            lengths = mask.sum(dim=1)
            if torch.any(lengths == 0):
                raise ValueError("every reference clip must contain at least one valid frame")

            weights = mask.unsqueeze(-1).to(reference_log_mel.dtype)
            value = (reference_log_mel * weights).transpose(1, 2)
            channel_mask = mask.unsqueeze(1).to(value.dtype)
            for layer in self.frontend:
                value = F.gelu(layer(value))
                value = value * channel_mask
            features = value.transpose(1, 2)
            weights = mask.unsqueeze(-1).to(features.dtype)
            denominator = lengths.unsqueeze(-1).to(features.dtype).clamp_min(1.0)
            mean = (features * weights).sum(dim=1) / denominator
            variance = (((features - mean.unsqueeze(1)).square()) * weights).sum(dim=1) / denominator
            pooled = torch.cat((mean, torch.sqrt(variance.clamp_min(1e-8))), dim=-1)
            embedding = self.projection(pooled)
            return F.normalize(embedding, p=2, dim=-1, eps=1e-8)

    return ReferenceSpeakerEncoder()
