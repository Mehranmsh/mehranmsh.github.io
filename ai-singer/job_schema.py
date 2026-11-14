"""Validation models for MEHRAN SVS job intake. No audio generation occurs here."""
from __future__ import annotations

import base64
import binascii
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ProjectInfo(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str = Field(min_length=1, max_length=160)
    name: str = Field(default="Untitled", max_length=70)
    language: str = Field(default="Persian", max_length=40)
    tempo: float | None = Field(default=None, ge=40, le=220)
    lyrics: str = Field(min_length=1, max_length=20000)


class MidiPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fileName: str = Field(max_length=120)
    mimeType: str = Field(max_length=100)
    size: int = Field(ge=14, le=5 * 1024 * 1024)
    encoding: Literal["base64"]
    data: str = Field(min_length=1, max_length=7 * 1024 * 1024)

    @field_validator("data")
    @classmethod
    def validate_midi_bytes(cls, value: str) -> str:
        try:
            raw = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("MIDI data is not valid base64") from exc
        if len(raw) < 14 or raw[:4] != b"MThd":
            raise ValueError("MIDI payload must begin with a Standard MIDI MThd header")
        if len(raw) > 5 * 1024 * 1024:
            raise ValueError("MIDI payload exceeds 5 MiB")
        return value

    @model_validator(mode="after")
    def size_matches(self) -> "MidiPayload":
        if len(base64.b64decode(self.data)) != self.size:
            raise ValueError("MIDI byte size does not match declared size")
        return self


class NoteEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: str = Field(min_length=1, max_length=12)
    startStep: float = Field(ge=0, le=1087)
    lengthSteps: float = Field(gt=0, le=1088)
    velocity: int = Field(default=80, ge=1, le=127)
    gate: int = Field(default=80, ge=1, le=100)


class MelodyInfo(BaseModel):
    model_config = ConfigDict(extra="allow")
    source: Literal["midi_file", "project_pattern", "not_provided"]
    midi: MidiPayload | None = None
    noteEvents: list[NoteEvent] = Field(default_factory=list, max_length=256)
    chords: list[str] = Field(default_factory=list, max_length=32)

    @model_validator(mode="after")
    def source_matches_payload(self) -> "MelodyInfo":
        if self.source == "midi_file" and self.midi is None:
            raise ValueError("melody.source is midi_file but no MIDI payload was supplied")
        if self.source == "project_pattern" and not self.noteEvents:
            raise ValueError("melody.source is project_pattern but no note events were supplied")
        return self


class SingerInfo(BaseModel):
    model_config = ConfigDict(extra="allow")
    name: str = Field(default="Lead Vocal", max_length=60)
    language: str = Field(default="Persian", max_length=40)
    role: str = Field(default="Lead", max_length=40)


class RenderInfo(BaseModel):
    model_config = ConfigDict(extra="allow")
    format: Literal["wav"] = "wav"
    sampleRate: Literal[48000] = 48000
    output: Literal["isolated_vocal_stem"] = "isolated_vocal_stem"


class EngineInfo(BaseModel):
    model_config = ConfigDict(extra="allow")
    provider: Literal["MEHRAN"] = "MEHRAN"
    deployment: Literal["self-hosted"] = "self-hosted"
    modelId: str = Field(default="mehran-svs-native", max_length=80)
    thirdPartyGenerationApi: Literal[False] = False


class SingingJob(BaseModel):
    model_config = ConfigDict(extra="allow")
    schema: Literal["mehran.svs.job.v1"]
    project: ProjectInfo
    singer: SingerInfo
    melody: MelodyInfo
    render: RenderInfo
    engine: EngineInfo

    @model_validator(mode="after")
    def require_some_melody_conditioning(self) -> "SingingJob":
        if self.melody.source == "not_provided" and self.melody.midi is None and not self.melody.noteEvents:
            raise ValueError("Provide a MIDI file or Piano Roll note events before vocal-job validation")
        return self
