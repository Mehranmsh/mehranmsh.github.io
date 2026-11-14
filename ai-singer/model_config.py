"""Versioned signal/feature contract for the first MEHRAN Persian SVS model.

This is a reproducible frontend specification, not a neural model or synthesizer.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator

from phoneme_inventory import INVENTORY_VERSION


class AcousticModelConfig(BaseModel):
    """Fixed acoustic representation expected by a future trained model."""

    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: str = Field(pattern=r"^mehran\.svs\.acoustic-config\.v1$")
    config_id: str = Field(min_length=3, max_length=100)
    language: str = Field(pattern=r"^fa$")
    phoneme_inventory_version: str = Field(min_length=1, max_length=100)

    sample_rate: int = Field(default=48000, ge=16000, le=96000)
    n_fft: int = Field(default=2048, ge=256, le=8192)
    win_length: int = Field(default=2048, ge=128, le=8192)
    hop_length: int = Field(default=256, ge=64, le=2048)
    mel_bins: int = Field(default=100, ge=40, le=256)
    f_min_hz: float = Field(default=40.0, ge=0.0, le=2000.0)
    f_max_hz: float = Field(default=16000.0, gt=1000.0, le=48000.0)
    mel_scale: str = Field(default="slaney", pattern=r"^slaney$")
    mel_normalization: str = Field(default="slaney", pattern=r"^slaney$")
    log_floor: float = Field(default=1e-5, gt=0.0, le=0.01)
    frame_alignment: str = Field(default="centered", pattern=r"^centered$")

    note_pitch_encoding: str = Field(default="midi_0_127", pattern=r"^midi_0_127$")
    pitch_track_encoding: str = Field(
        default="continuous_hz_plus_voicing_mask",
        pattern=r"^continuous_hz_plus_voicing_mask$",
    )
    energy_track_encoding: str = Field(default="log_rms", pattern=r"^log_rms$")

    target_features: list[str] = Field(
        default_factory=lambda: ["log_mel", "f0_hz", "voicing_mask", "log_rms"],
        min_length=4,
        max_length=4,
    )

    @model_validator(mode="after")
    def validate_signal_geometry(self) -> "AcousticModelConfig":
        if self.phoneme_inventory_version != INVENTORY_VERSION:
            raise ValueError("phoneme inventory version does not match the installed Persian inventory")
        if self.win_length > self.n_fft:
            raise ValueError("win_length cannot exceed n_fft")
        if self.hop_length > self.win_length:
            raise ValueError("hop_length cannot exceed win_length")
        if self.f_max_hz > self.sample_rate / 2:
            raise ValueError("f_max_hz cannot exceed the Nyquist frequency")
        if self.f_min_hz >= self.f_max_hz:
            raise ValueError("f_min_hz must be lower than f_max_hz")
        if len(set(self.target_features)) != 4 or set(self.target_features) != {
            "log_mel", "f0_hz", "voicing_mask", "log_rms"
        }:
            raise ValueError("target_features must contain each supported feature exactly once")
        return self

    @property
    def frame_rate_hz(self) -> float:
        return self.sample_rate / self.hop_length


def validate_acoustic_model_config(payload: dict) -> AcousticModelConfig:
    """Validate a model's signal contract without loading weights."""
    return AcousticModelConfig.model_validate(payload)
