"""Experimental neural waveform decoder for MEHRAN Persian SVS.

This is an untrained waveform generator architecture. It requires paired
waveform targets and objective/listening evaluation before production use.
"""
from __future__ import annotations

from dataclasses import dataclass
from math import prod

from speaker_encoder import build_speaker_encoder


@dataclass(frozen=True)
class WaveformDecoderConfig:
    mel_bins: int = 100
    sample_rate: int = 48000
    hop_length: int = 256
    initial_channels: int = 256
    upsample_factors: tuple[int, ...] = (4, 4, 4, 4)
    residual_dilations: tuple[int, ...] = (1, 3, 5)
    speaker_embedding_size: int = 192

    def validate(self) -> "WaveformDecoderConfig":
        if self.mel_bins < 1 or self.sample_rate not in {22050, 24000, 44100, 48000}:
            raise ValueError("invalid mel bins or supported sample rate")
        if self.hop_length < 1 or not self.upsample_factors:
            raise ValueError("hop length and upsample factors must be positive")
        if any(isinstance(x, bool) or not isinstance(x, int) or x < 2 for x in self.upsample_factors):
            raise ValueError("upsample factors must be integers >= 2")
        if any(factor % 2 for factor in self.upsample_factors):
            raise ValueError("upsample factors must be even to preserve exact frame-to-sample length")
        if prod(self.upsample_factors) != self.hop_length:
            raise ValueError("upsample factor product must equal acoustic hop_length")
        if self.initial_channels < 32 or self.initial_channels % (2 ** len(self.upsample_factors)):
            raise ValueError("initial_channels must be >=32 and divisible by 2^number_of_stages")
        if not self.residual_dilations or any(
            isinstance(x, bool) or not isinstance(x, int) or x < 1 for x in self.residual_dilations
        ):
            raise ValueError("residual dilations must be positive integers")
        if self.speaker_embedding_size < 16:
            raise ValueError("speaker_embedding_size must be >=16")
        return self


def build_waveform_decoder(config: WaveformDecoderConfig | None = None):
    """Build a frame-to-PCM neural decoder; output is (batch, samples)."""
    try:
        import torch
        from torch import nn
        from torch.nn import functional as F
    except ImportError as exc:
        raise RuntimeError("PyTorch is required; install training-requirements.txt") from exc

    cfg = (config or WaveformDecoderConfig()).validate()

    class ResidualUnit(nn.Module):
        def __init__(self, channels: int, dilation: int):
            super().__init__()
            padding = dilation
            self.layers = nn.Sequential(
                nn.LeakyReLU(0.1),
                nn.Conv1d(channels, channels, kernel_size=3, padding=padding, dilation=dilation),
                nn.LeakyReLU(0.1),
                nn.Conv1d(channels, channels, kernel_size=1),
            )

        def forward(self, value):
            return value + self.layers(value)

    class Decoder(nn.Module):
        def __init__(self):
            super().__init__()
            self.speaker_encoder = build_speaker_encoder(cfg.mel_bins, cfg.speaker_embedding_size)
            self.speaker_projection = nn.Linear(cfg.speaker_embedding_size, cfg.initial_channels)
            self.condition_projection = nn.Conv1d(cfg.mel_bins + 3, cfg.initial_channels, 7, padding=3)
            stages = []
            channels = cfg.initial_channels
            for factor in cfg.upsample_factors:
                next_channels = channels // 2
                stages.append(nn.ModuleDict({
                    "upsample": nn.ConvTranspose1d(
                        channels, next_channels, kernel_size=factor * 2,
                        stride=factor, padding=factor // 2,
                    ),
                    "residual": nn.Sequential(
                        *[ResidualUnit(next_channels, dilation) for dilation in cfg.residual_dilations]
                    ),
                }))
                channels = next_channels
            self.stages = nn.ModuleList(stages)
            self.output = nn.Sequential(
                nn.LeakyReLU(0.1),
                nn.Conv1d(channels, 1, kernel_size=7, padding=3),
                nn.Tanh(),
            )

        def forward(
            self, log_mel, f0_hz, voicing, log_rms,
            speaker_reference_log_mel, speaker_reference_frame_mask,
        ):
            if log_mel.ndim != 3 or log_mel.shape[-1] != cfg.mel_bins:
                raise ValueError("log_mel must have shape (batch, frames, mel_bins)")
            shape = log_mel.shape[:2]
            if any(value.shape != shape for value in (f0_hz, voicing, log_rms)):
                raise ValueError("F0, voicing, and energy must align with mel frames")
            if speaker_reference_log_mel is None or speaker_reference_frame_mask is None:
                raise ValueError("a separate speaker reference and frame mask are required")
            if speaker_reference_log_mel.ndim != 3 or speaker_reference_log_mel.shape[0] != shape[0]:
                raise ValueError("speaker reference must have shape (batch, reference_frames, mel_bins)")
            if speaker_reference_log_mel.shape[-1] != cfg.mel_bins:
                raise ValueError("speaker reference mel dimension does not match decoder")
            if speaker_reference_frame_mask.shape != speaker_reference_log_mel.shape[:2]:
                raise ValueError("speaker reference mask shape does not match reference frames")
            if torch.any(speaker_reference_frame_mask.to(torch.bool).sum(dim=1) == 0):
                raise ValueError("each speaker reference must contain a valid frame")

            controls = torch.stack((torch.log1p(f0_hz.clamp_min(0.0)), voicing, log_rms), dim=-1)
            hidden = self.condition_projection(torch.cat((log_mel, controls), dim=-1).transpose(1, 2))
            speaker = self.speaker_encoder(speaker_reference_log_mel, speaker_reference_frame_mask)
            hidden = hidden + self.speaker_projection(speaker).unsqueeze(-1)
            for stage in self.stages:
                hidden = stage["upsample"](hidden)
                hidden = stage["residual"](hidden)
            return self.output(hidden).squeeze(1)

    return Decoder()
