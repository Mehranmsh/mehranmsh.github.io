"""Safe discovery and integrity checks for a future MEHRAN acoustic model artifact.

This module does not deserialize checkpoints or execute model code. A verified
artifact is not the same as a loaded model or an available synthesis engine.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

MANIFEST_NAME = "model-manifest.json"
MAX_MANIFEST_BYTES = 64 * 1024
MAX_CHECKPOINT_BYTES = 20 * 1024 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SUPPORTED_SAMPLE_RATES = {22050, 24000, 44100, 48000}


def _unavailable(reason: str, model_dir: str) -> dict[str, Any]:
    return {
        "artifact_present": False, "artifact_verified": False,
        "model_loaded": False, "inference_ready": False,
        "model_id": None, "architecture": None, "framework": None,
        "sample_rate": None, "languages": [], "reason": reason,
        "model_directory": model_dir,
    }


def inspect_model_artifact(model_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Verify a local manifest and checkpoint without loading executable weights."""
    configured = str(model_dir or os.getenv("MEHRAN_SVS_MODEL_DIR", "models"))
    root = Path(configured).expanduser()
    try:
        root = root.resolve(strict=True)
    except (OSError, RuntimeError):
        return _unavailable("model_directory_missing", configured)
    if not root.is_dir():
        return _unavailable("model_directory_not_a_directory", configured)

    try:
        manifest_path = (root / MANIFEST_NAME).resolve(strict=True)
        manifest_path.relative_to(root)
        if not manifest_path.is_file() or manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
            return _unavailable("manifest_missing_or_too_large", configured)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, RuntimeError):
        return _unavailable("manifest_invalid_or_unreadable", configured)

    if not isinstance(manifest, dict):
        return _unavailable("manifest_must_be_an_object", configured)
    required = {
        "schema_version", "model_id", "architecture", "framework",
        "checkpoint", "sha256", "sample_rate", "languages", "task",
    }
    if not required.issubset(manifest):
        return _unavailable("manifest_fields_missing", configured)
    text_fields = ("schema_version", "model_id", "architecture", "framework", "checkpoint", "sha256", "task")
    if any(not isinstance(manifest[key], str) or not manifest[key].strip() for key in text_fields):
        return _unavailable("manifest_text_fields_invalid", configured)
    if manifest["schema_version"] != "mehran.svs.model.v1":
        return _unavailable("unsupported_manifest_schema", configured)
    if manifest["task"] != "singing_voice_synthesis":
        return _unavailable("unsupported_model_task", configured)
    if not SHA256_RE.fullmatch(manifest["sha256"]):
        return _unavailable("invalid_checkpoint_sha256", configured)
    if type(manifest["sample_rate"]) is not int or manifest["sample_rate"] not in SUPPORTED_SAMPLE_RATES:
        return _unavailable("unsupported_sample_rate", configured)
    languages = manifest["languages"]
    if (
        not isinstance(languages, list) or not languages
        or any(not isinstance(item, str) or not item.strip() for item in languages)
        or len(set(languages)) != len(languages)
    ):
        return _unavailable("invalid_languages", configured)

    checkpoint_rel = Path(manifest["checkpoint"])
    if checkpoint_rel.is_absolute() or ".." in checkpoint_rel.parts:
        return _unavailable("unsafe_checkpoint_path", configured)
    try:
        checkpoint = (root / checkpoint_rel).resolve(strict=True)
        checkpoint.relative_to(root)
        if not checkpoint.is_file():
            return _unavailable("checkpoint_not_a_file", configured)
        size = checkpoint.stat().st_size
        if size <= 0 or size > MAX_CHECKPOINT_BYTES:
            return _unavailable("checkpoint_size_invalid", configured)
        digest = hashlib.sha256()
        with checkpoint.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except (OSError, RuntimeError, ValueError):
        return _unavailable("checkpoint_missing_or_unreadable", configured)
    if digest.hexdigest() != manifest["sha256"]:
        return _unavailable("checkpoint_hash_mismatch", configured)

    return {
        "artifact_present": True, "artifact_verified": True,
        "model_loaded": False, "inference_ready": False,
        "model_id": manifest["model_id"], "architecture": manifest["architecture"],
        "framework": manifest["framework"], "sample_rate": manifest["sample_rate"],
        "languages": languages,
        "reason": "artifact_verified_but_loader_and_inference_not_implemented",
        "model_directory": configured,
    }
