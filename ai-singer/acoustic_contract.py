"""Typed conditioning contract for the future MEHRAN acoustic singing model.

This validates model inputs only. It does not load weights or synthesize audio.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class PhonemeSpan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    phoneme: str = Field(min_length=1, max_length=16)
    start_seconds: float = Field(ge=0, le=3600)
    end_seconds: float = Field(gt=0, le=3600)

    @model_validator(mode="after")
    def positive_duration(self) -> "PhonemeSpan":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("phoneme end_seconds must be after start_seconds")
        return self


class NoteCondition(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    midi_note: int = Field(ge=0, le=127)
    start_seconds: float = Field(ge=0, le=3600)
    duration_seconds: float = Field(gt=0, le=30)
    velocity: int = Field(default=80, ge=1, le=127)


class VocalStyle(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    pitch_shift_semitones: float = Field(default=0, ge=-12, le=12)
    energy: float = Field(default=0.7, ge=0, le=1)
    breathiness: float = Field(default=0.15, ge=0, le=1)
    vibrato_depth: float = Field(default=0.15, ge=0, le=1)
    vibrato_rate_hz: float = Field(default=5.2, ge=3, le=8)


class AcousticConditioning(BaseModel):
    """Versioned, model-neutral input contract for one isolated vocal stem."""
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: str = Field(pattern=r"^mehran\.svs\.conditioning\.v1$")
    project_id: str = Field(min_length=1, max_length=160)
    language: str = Field(pattern=r"^(fa|en)$")
    sample_rate: int = Field(default=48000, ge=16000, le=96000)
    duration_seconds: float = Field(gt=0, le=600)
    speaker_profile_id: str | None = Field(default=None, min_length=1, max_length=120)
    phonemes: list[PhonemeSpan] = Field(min_length=1, max_length=4000)
    notes: list[NoteCondition] = Field(min_length=1, max_length=4096)
    style: VocalStyle = Field(default_factory=VocalStyle)

    @field_validator("sample_rate")
    @classmethod
    def supported_sample_rate(cls, value: int) -> int:
        if value not in {22050, 24000, 44100, 48000}:
            raise ValueError("sample_rate must be 22050, 24000, 44100, or 48000")
        return value

    @model_validator(mode="after")
    def validate_timeline(self) -> "AcousticConditioning":
        previous_start = -1.0
        previous_end = 0.0
        for span in self.phonemes:
            if span.start_seconds < previous_start or span.start_seconds < previous_end:
                raise ValueError("phoneme spans must be ordered and non-overlapping")
            if span.end_seconds > self.duration_seconds:
                raise ValueError("phoneme span exceeds conditioning duration")
            previous_start = span.start_seconds
            previous_end = span.end_seconds

        previous_note_start = -1.0
        for note in self.notes:
            if note.start_seconds < previous_note_start:
                raise ValueError("note events must be ordered by start_seconds")
            if note.start_seconds + note.duration_seconds > self.duration_seconds + 1e-6:
                raise ValueError("note event exceeds conditioning duration")
            previous_note_start = note.start_seconds
        return self


def validate_acoustic_conditioning(payload: dict) -> AcousticConditioning:
    """Parse and validate the future acoustic model input contract."""
    return AcousticConditioning.model_validate(payload)
