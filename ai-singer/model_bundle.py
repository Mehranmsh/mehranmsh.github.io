"""Integrity gate for the two-checkpoint MEHRAN Persian singing model bundle.

Verifying a bundle does not load weights or mark inference ready.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from model_architecture import SingingNetworkConfig
from model_config import validate_acoustic_model_config
from waveform_decoder import WaveformDecoderConfig

MANIFEST_NAME = "singing-bundle.json"
MAX_MANIFEST_BYTES = 128 * 1024
MAX_CHECKPOINT_BYTES = 20 * 1024 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _unavailable(reason: str, directory: str) -> dict:
    return {
        "bundle_present": False,
        "bundle_verified": False,
        "model_loaded": False,
        "inference_ready": False,
        "bundle_id": None,
        "reason": reason,
        "model_directory": directory,
    }


def _verify_checkpoint(root: Path, entry: object) -> tuple[bool, str]:
    if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
        return False, "checkpoint_entry_invalid"
    relative_text = entry.get("path")
    digest_expected = entry.get("sha256")
    if not isinstance(relative_text, str) or not relative_text.strip():
        return False, "checkpoint_path_invalid"
    if not isinstance(digest_expected, str) or not SHA256_RE.fullmatch(digest_expected):
        return False, "checkpoint_sha256_invalid"
    relative = Path(relative_text)
    if relative.is_absolute() or ".." in relative.parts:
        return False, "unsafe_checkpoint_path"
    candidate = root
    for part in relative.parts:
        candidate = candidate / part
        if candidate.is_symlink():
            return False, "checkpoint_symlink_rejected"
    try:
        checkpoint = candidate.resolve(strict=True)
        checkpoint.relative_to(root)
        if not checkpoint.is_file():
            return False, "checkpoint_not_a_file"
        size = checkpoint.stat().st_size
        if size <= 0 or size > MAX_CHECKPOINT_BYTES:
            return False, "checkpoint_size_invalid"
        digest = hashlib.sha256()
        with checkpoint.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except (OSError, RuntimeError, ValueError):
        return False, "checkpoint_missing_or_unreadable"
    if digest.hexdigest() != digest_expected:
        return False, "checkpoint_hash_mismatch"
    return True, "verified"


def inspect_singing_bundle(model_dir: str | Path) -> dict:
    """Validate the bundle manifest, model configs, safe paths, and both hashes."""
    configured = str(model_dir)
    requested = Path(model_dir).expanduser()
    if requested.is_symlink():
        return _unavailable("model_directory_symlink_rejected", configured)
    try:
        root = requested.resolve(strict=True)
    except (OSError, RuntimeError):
        return _unavailable("model_directory_missing", configured)
    if not root.is_dir():
        return _unavailable("model_directory_not_a_directory", configured)

    manifest_path = root / MANIFEST_NAME
    if manifest_path.is_symlink():
        return _unavailable("manifest_symlink_rejected", configured)
    try:
        if not manifest_path.is_file() or manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
            return _unavailable("manifest_missing_or_too_large", configured)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return _unavailable("manifest_invalid_or_unreadable", configured)
    if not isinstance(manifest, dict):
        return _unavailable("manifest_must_be_an_object", configured)

    required = {
        "schema_version", "bundle_id", "task", "languages", "sample_rate",
        "acoustic_feature_config", "acoustic_model_config", "waveform_decoder_config",
        "acoustic_checkpoint", "waveform_checkpoint",
    }
    if set(manifest) != required:
        return _unavailable("manifest_fields_invalid", configured)
    if manifest["schema_version"] != "mehran.svs.bundle.v1":
        return _unavailable("unsupported_manifest_schema", configured)
    if not isinstance(manifest["bundle_id"], str) or not manifest["bundle_id"].strip():
        return _unavailable("bundle_id_invalid", configured)
    if manifest["task"] != "singing_voice_synthesis" or manifest["languages"] != ["fa"]:
        return _unavailable("unsupported_task_or_language", configured)
    if type(manifest["sample_rate"]) is not int:
        return _unavailable("sample_rate_invalid", configured)

    try:
        feature_config = validate_acoustic_model_config(manifest["acoustic_feature_config"])
        acoustic_config = SingingNetworkConfig(**manifest["acoustic_model_config"]).validate()
        decoder_config = WaveformDecoderConfig(**manifest["waveform_decoder_config"]).validate()
    except (TypeError, ValueError, KeyError):
        return _unavailable("model_config_invalid", configured)
    if (
        feature_config.sample_rate != manifest["sample_rate"]
        or acoustic_config.mel_bins != feature_config.mel_bins
        or decoder_config.mel_bins != feature_config.mel_bins
        or decoder_config.sample_rate != feature_config.sample_rate
        or decoder_config.hop_length != feature_config.hop_length
    ):
        return _unavailable("model_config_contract_mismatch", configured)

    for field in ("acoustic_checkpoint", "waveform_checkpoint"):
        ok, reason = _verify_checkpoint(root, manifest[field])
        if not ok:
            return _unavailable(f"{field}:{reason}", configured)

    return {
        "bundle_present": True,
        "bundle_verified": True,
        "model_loaded": False,
        "inference_ready": False,
        "bundle_id": manifest["bundle_id"],
        "sample_rate": feature_config.sample_rate,
        "language": "fa",
        "reason": "bundle_verified_but_runtime_loading_and_quality_approval_are_separate",
        "model_directory": configured,
    }
