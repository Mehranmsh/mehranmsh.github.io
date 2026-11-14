"""First trainable MEHRAN Persian SVS acoustic network definition.

PyTorch is an optional training dependency. Importing the API does not require it.
This module defines a trainable network only; it does not load weights, train,
or synthesize a waveform.
"""
from __future__ import annotations

from dataclasses import dataclass

from phoneme_inventory import PHONEME_FEATURES
from speaker_encoder import build_speaker_encoder


@dataclass(frozen=True)
class SingingNetworkConfig:
    """Shape and capacity settings for the first experimental acoustic model."""

    mel_bins: int = 100
    phoneme_vocab_size: int = len(PHONEME_FEATURES) + 1
    note_vocab_size: int = 129
    hidden_size: int = 192
    attention_heads: int = 4
    encoder_layers: int = 4
    convolution_layers: int = 4
    feedforward_size: int = 768
    dropout: float = 0.1

    def validate(self) -> "SingingNetworkConfig":
        if self.mel_bins < 1 or self.phoneme_vocab_size < 2 or self.note_vocab_size != 129:
            raise ValueError("invalid acoustic or token vocabulary dimensions")
        if self.attention_heads < 1 or self.encoder_layers < 1 or self.convolution_layers < 1:
            raise ValueError("network depth and attention_heads must be positive")
        if self.hidden_size < 16 or self.hidden_size % self.attention_heads:
            raise ValueError("hidden_size must be >=16 and divisible by attention_heads")
        if self.feedforward_size < self.hidden_size:
            raise ValueError("feedforward_size must be >= hidden_size")
        if not 0.0 <= self.dropout < 1.0:
            raise ValueError("dropout must be in [0, 1)")
        if self.phoneme_vocab_size != len(PHONEME_FEATURES) + 1:
            raise ValueError("phoneme vocabulary size must match the installed inventory plus padding")
        return self


def build_singing_model(config: SingingNetworkConfig | None = None):
    """Build a frame-synchronous phoneme/note-conditioned acoustic network.

    Inputs are aligned frame tensors from TrainingBatch. Outputs are acoustic
    feature predictions, not waveform samples. The caller must train and
    evaluate this network before any inference use.
    """
    try:
        import torch
        from torch import nn
        from torch.nn import functional as F
    except ImportError as exc:
        raise RuntimeError(
            "PyTorch is required only for model training; install ai-singer/training-requirements.txt"
        ) from exc

    cfg = (config or SingingNetworkConfig()).validate()

    class ResidualConvBlock(nn.Module):
        def __init__(self, channels: int):
            super().__init__()
            self.norm = nn.LayerNorm(channels)
            self.depthwise = nn.Conv1d(channels, channels, kernel_size=5, padding=2, groups=channels)
            self.pointwise = nn.Conv1d(channels, channels, kernel_size=1)
            self.dropout = nn.Dropout(cfg.dropout)

        def forward(self, value):
            residual = value
            value = self.norm(value).transpose(1, 2)
            value = self.depthwise(value)
            value = F.gelu(self.pointwise(value)).transpose(1, 2)
            return residual + self.dropout(value)

    class MehranPersianSingingNetwork(nn.Module):
        def __init__(self):
            super().__init__()
            h = cfg.hidden_size
            self.phoneme_embedding = nn.Embedding(cfg.phoneme_vocab_size, h, padding_idx=0)
            self.note_embedding = nn.Embedding(cfg.note_vocab_size, h, padding_idx=0)
            self.speaker_encoder = build_speaker_encoder(cfg.mel_bins, h)
            self.speaker_projection = nn.Linear(h, h)
            self.condition_projection = nn.Sequential(
                nn.Linear(3, h),
                nn.GELU(),
                nn.Linear(h, h),
            )
            self.input_norm = nn.LayerNorm(h)
            encoder_layer = nn.TransformerEncoderLayer(
                d_model=h,
                nhead=cfg.attention_heads,
                dim_feedforward=cfg.feedforward_size,
                dropout=cfg.dropout,
                activation="gelu",
                batch_first=True,
                norm_first=True,
            )
            self.encoder = nn.TransformerEncoder(
                encoder_layer,
                num_layers=cfg.encoder_layers,
                norm=nn.LayerNorm(h),
            )
            self.decoder = nn.ModuleList(
                [ResidualConvBlock(h) for _ in range(cfg.convolution_layers)]
            )
            self.output_norm = nn.LayerNorm(h)
            self.mel_head = nn.Linear(h, cfg.mel_bins)
            self.f0_head = nn.Linear(h, 1)
            self.voicing_head = nn.Linear(h, 1)
            self.energy_head = nn.Linear(h, 1)

        def forward(
            self,
            phoneme_ids,
            note_ids,
            conditioning_f0_hz,
            conditioning_voicing_mask,
            conditioning_energy,
            valid_frame_mask,
            speaker_reference_log_mel=None,
            speaker_reference_frame_mask=None,
        ):
            tensors = (phoneme_ids, note_ids, conditioning_f0_hz,
                       conditioning_voicing_mask, conditioning_energy, valid_frame_mask)
            if any(value.ndim != 2 for value in tensors):
                raise ValueError("all model inputs must have shape (batch, frames)")
            shape = phoneme_ids.shape
            if any(value.shape != shape for value in tensors[1:]):
                raise ValueError("all model inputs must share the same batch/frame shape")
            if torch.any(valid_frame_mask.to(torch.bool).sum(dim=1) == 0):
                raise ValueError("every sample must contain at least one valid frame")
            if torch.any(phoneme_ids < 0) or torch.any(phoneme_ids >= cfg.phoneme_vocab_size):
                raise ValueError("phoneme IDs exceed the configured inventory")
            if torch.any(note_ids < 0) or torch.any(note_ids >= cfg.note_vocab_size):
                raise ValueError("note IDs exceed the configured MIDI vocabulary")

            valid = valid_frame_mask.to(torch.bool)
            f0 = torch.log1p(conditioning_f0_hz.clamp_min(0.0))
            voice = conditioning_voicing_mask.to(dtype=f0.dtype)
            energy = conditioning_energy
            controls = torch.stack((f0, voice, energy), dim=-1)
            hidden = (
                self.phoneme_embedding(phoneme_ids)
                + self.note_embedding(note_ids)
                + self.condition_projection(controls)
            )
            if (speaker_reference_log_mel is None) != (speaker_reference_frame_mask is None):
                raise ValueError("speaker reference mel and frame mask must be provided together")
            if speaker_reference_log_mel is not None:
                speaker_embedding = self.speaker_encoder(
                    speaker_reference_log_mel, speaker_reference_frame_mask
                )
                hidden = hidden + self.speaker_projection(speaker_embedding).unsqueeze(1)
            hidden = self.input_norm(hidden)
            hidden = self.encoder(hidden, src_key_padding_mask=~valid)
            for block in self.decoder:
                hidden = block(hidden)
            hidden = self.output_norm(hidden)
            mask = valid.unsqueeze(-1).to(hidden.dtype)
            return {
                "log_mel": self.mel_head(hidden) * mask,
                "f0_hz": F.softplus(self.f0_head(hidden).squeeze(-1)) * valid,
                "voicing_logits": self.voicing_head(hidden).squeeze(-1) * valid,
                "log_rms": self.energy_head(hidden).squeeze(-1) * valid,
            }

    return MehranPersianSingingNetwork()
