"""Atomic mono PCM WAV writer for output from the native MEHRAN pipeline.

This module serializes supplied samples. It is not a synthesizer.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import tempfile
import uuid
import wave

import numpy as np

from synthesis_runtime import SUPPORTED_SAMPLE_RATES, verify_synthesis_output


def write_waveform_output(
    samples,
    *,
    output_directory: str | Path,
    project_id: str,
    sample_rate: int,
) -> dict:
    """Write normalized float samples as an atomic PCM16 WAV and verify it."""
    if sample_rate not in SUPPORTED_SAMPLE_RATES:
        raise ValueError("unsupported output sample rate")
    audio = np.asarray(samples, dtype=np.float32)
    if audio.ndim != 1 or audio.size == 0:
        raise ValueError("waveform must be a non-empty mono sample array")
    if audio.size > sample_rate * 600:
        raise ValueError("waveform duration cannot exceed 600 seconds")
    if not np.isfinite(audio).all() or np.any(audio < -1.0) or np.any(audio > 1.0):
        raise ValueError("waveform samples must be finite and normalized to [-1, 1]")
    if not isinstance(project_id, str) or not project_id.strip():
        raise ValueError("project_id must be a non-empty string")

    requested_root = Path(output_directory).expanduser()
    if requested_root.is_symlink():
        raise ValueError("output directory cannot be a symbolic link")
    requested_root.mkdir(parents=True, exist_ok=True)
    root = requested_root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("output directory must be a directory")

    filename = f"vocal-{uuid.uuid4().hex}.wav"
    destination = root / filename
    pcm = np.round(audio * 32767.0).astype("<i2")
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=".mehran-vocal-", suffix=".tmp", dir=root, delete=False
        ) as handle:
            temp_name = handle.name
        with wave.open(temp_name, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(pcm.tobytes())
        with open(temp_name, "rb") as handle:
            os.fsync(handle.fileno())
        if destination.exists() or destination.is_symlink():
            raise FileExistsError("generated output filename unexpectedly exists")
        os.replace(temp_name, destination)
        temp_name = None
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)

    digest = hashlib.sha256()
    with destination.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    payload = {
        "schema_version": "mehran.svs.output.v1",
        "project_id": project_id,
        "artifact_path": filename,
        "format": "wav",
        "codec": "pcm_s16le",
        "sample_rate": sample_rate,
        "channels": 1,
        "duration_seconds": audio.size / sample_rate,
        "frames": int(audio.size),
        "sha256": digest.hexdigest(),
    }
    return verify_synthesis_output(
        payload, output_directory=root, expected_project_id=project_id
    )
