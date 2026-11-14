"""Runtime boundary and WAV artifact verification for native MEHRAN singing inference.

This module defines the contract only. It deliberately contains no fake synthesizer,
checkpoint deserializer, external API client, or claim that inference is available.
"""
from __future__ import annotations

import hashlib
import re
import wave
from pathlib import Path
from typing import Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SUPPORTED_SAMPLE_RATES = {22050, 24000, 44100, 48000}
MAX_AUDIO_BYTES = 500 * 1024 * 1024


class SynthesisOutput(BaseModel):
    """Metadata emitted by a future native runtime after writing its WAV stem."""
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: str = Field(pattern=r"^mehran\.svs\.output\.v1$")
    project_id: str = Field(min_length=1, max_length=160)
    artifact_path: str = Field(min_length=1, max_length=512)
    format: str = Field(pattern=r"^wav$")
    codec: str = Field(pattern=r"^pcm_s(16|24|32)le$")
    sample_rate: int
    channels: int = Field(default=1)
    duration_seconds: float = Field(gt=0, le=600)
    frames: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def supported_audio_profile(self) -> "SynthesisOutput":
        if self.sample_rate not in SUPPORTED_SAMPLE_RATES:
            raise ValueError("unsupported output sample rate")
        if self.channels != 1:
            raise ValueError("singing stem must be mono")
        return self


@runtime_checkable
class SingingSynthesisRuntime(Protocol):
    """Interface a future in-house model adapter must implement."""

    def load(self, model_directory: Path) -> None:
        """Load and validate native model weights, or raise a typed error."""
        ...

    def synthesize(self, conditioning: dict, output_directory: Path) -> SynthesisOutput:
        """Render one isolated vocal WAV stem using the loaded native model."""
        ...


def verify_synthesis_output(
    payload: dict,
    *,
    output_directory: str | Path,
    expected_project_id: str,
) -> dict:
    """Verify output metadata, path containment, PCM WAV header, duration, and digest."""
    try:
        result = SynthesisOutput.model_validate(payload)
    except ValidationError:
        raise

    if result.project_id != expected_project_id:
        raise ValueError("output project_id does not match the requested project")

    root = Path(output_directory).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("output directory is not a directory")

    relative = Path(result.artifact_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("unsafe output artifact path")
    candidate = root / relative
    if candidate.is_symlink():
        raise ValueError("symbolic-link output artifacts are not accepted")
    try:
        artifact = candidate.resolve(strict=True)
        artifact.relative_to(root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("output artifact is missing or outside the output directory") from exc
    if not artifact.is_file():
        raise ValueError("output artifact is not a regular file")
    size = artifact.stat().st_size
    if size <= 44 or size > MAX_AUDIO_BYTES:
        raise ValueError("output WAV size is invalid")

    digest = hashlib.sha256()
    with artifact.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != result.sha256:
        raise ValueError("output artifact SHA-256 mismatch")

    try:
        with wave.open(str(artifact), "rb") as wav:
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            frames = wav.getnframes()
            compression = wav.getcomptype()
    except (wave.Error, EOFError) as exc:
        raise ValueError("output is not a readable PCM WAV file") from exc

    width_to_codec = {2: "pcm_s16le", 3: "pcm_s24le", 4: "pcm_s32le"}
    if compression != "NONE" or sample_width not in width_to_codec:
        raise ValueError("output WAV must use 16, 24, or 32-bit integer PCM")
    if width_to_codec[sample_width] != result.codec:
        raise ValueError("declared codec does not match WAV sample width")
    if channels != 1 or channels != result.channels:
        raise ValueError("output WAV must contain exactly one channel")
    if sample_rate != result.sample_rate:
        raise ValueError("declared sample rate does not match WAV header")
    if sample_rate not in SUPPORTED_SAMPLE_RATES or frames != result.frames:
        raise ValueError("declared frame count or sample rate does not match WAV header")

    actual_duration = frames / sample_rate
    if abs(actual_duration - result.duration_seconds) > (1 / sample_rate):
        raise ValueError("declared duration does not match WAV frame count")

    return {
        "valid": True,
        "project_id": result.project_id,
        "artifact_path": result.artifact_path,
        "format": "wav",
        "codec": result.codec,
        "sample_rate": sample_rate,
        "channels": channels,
        "frames": frames,
        "duration_seconds": actual_duration,
        "sha256": digest.hexdigest(),
        "audio_generated": True,
        "verification": "pcm_header_and_sha256",
    }
