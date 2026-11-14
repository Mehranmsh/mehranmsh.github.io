"""Integrity manifest for a jointly fine-tuned Persian singing pipeline checkpoint."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from model_architecture import SingingNetworkConfig
from model_config import validate_acoustic_model_config
from waveform_decoder import WaveformDecoderConfig

MANIFEST_NAME = "joint-singing-bundle.json"
MAX_MANIFEST_BYTES = 128 * 1024
MAX_CHECKPOINT_BYTES = 20 * 1024 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _failed(reason: str, directory: str) -> dict:
    return {
        "bundle_present": False,
        "bundle_verified": False,
        "runtime_loaded": False,
        "production_approved": False,
        "bundle_id": None,
        "reason": reason,
        "bundle_directory": directory,
    }


def inspect_joint_singing_bundle(bundle_dir: str | Path) -> dict:
    configured = str(bundle_dir)
    requested = Path(bundle_dir).expanduser()
    if requested.is_symlink():
        return _failed("bundle_directory_symlink_rejected", configured)
    try:
        root = requested.resolve(strict=True)
        if not root.is_dir():
            return _failed("bundle_directory_not_a_directory", configured)
        manifest_path = root / MANIFEST_NAME
        if manifest_path.is_symlink():
            return _failed("manifest_symlink_rejected", configured)
        if not manifest_path.is_file() or manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
            return _failed("manifest_missing_or_too_large", configured)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, RuntimeError, UnicodeDecodeError, json.JSONDecodeError):
        return _failed("manifest_invalid_or_unreadable", configured)
    if not isinstance(manifest, dict):
        return _failed("manifest_must_be_an_object", configured)

    required = {
        "schema_version", "bundle_id", "task", "languages", "sample_rate",
        "acoustic_feature_config", "acoustic_model_config",
        "waveform_decoder_config", "pipeline_checkpoint",
    }
    if set(manifest) != required:
        return _failed("manifest_fields_invalid", configured)
    if manifest["schema_version"] != "mehran.svs.joint-bundle.v1":
        return _failed("unsupported_manifest_schema", configured)
    if not isinstance(manifest["bundle_id"], str) or not manifest["bundle_id"].strip():
        return _failed("bundle_id_invalid", configured)
    if manifest["task"] != "singing_voice_synthesis" or manifest["languages"] != ["fa"]:
        return _failed("unsupported_task_or_language", configured)
    if type(manifest["sample_rate"]) is not int:
        return _failed("sample_rate_invalid", configured)

    try:
        feature = validate_acoustic_model_config(manifest["acoustic_feature_config"])
        acoustic = SingingNetworkConfig(**manifest["acoustic_model_config"]).validate()
        decoder = WaveformDecoderConfig(**manifest["waveform_decoder_config"]).validate()
    except (TypeError, ValueError, KeyError):
        return _failed("model_config_invalid", configured)
    if (
        feature.sample_rate != manifest["sample_rate"]
        or acoustic.mel_bins != feature.mel_bins
        or decoder.mel_bins != feature.mel_bins
        or decoder.sample_rate != feature.sample_rate
        or decoder.hop_length != feature.hop_length
    ):
        return _failed("model_config_contract_mismatch", configured)

    entry = manifest["pipeline_checkpoint"]
    if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
        return _failed("checkpoint_entry_invalid", configured)
    relative_text, expected_hash = entry.get("path"), entry.get("sha256")
    if not isinstance(relative_text, str) or not relative_text.strip():
        return _failed("checkpoint_path_invalid", configured)
    if not isinstance(expected_hash, str) or not SHA256_RE.fullmatch(expected_hash):
        return _failed("checkpoint_sha256_invalid", configured)
    relative = Path(relative_text)
    if relative.is_absolute() or ".." in relative.parts:
        return _failed("unsafe_checkpoint_path", configured)

    candidate = root
    for part in relative.parts:
        candidate = candidate / part
        if candidate.is_symlink():
            return _failed("checkpoint_symlink_rejected", configured)
    try:
        checkpoint = candidate.resolve(strict=True)
        checkpoint.relative_to(root)
        if not checkpoint.is_file():
            return _failed("checkpoint_not_a_file", configured)
        size = checkpoint.stat().st_size
        if size <= 0 or size > MAX_CHECKPOINT_BYTES:
            return _failed("checkpoint_size_invalid", configured)
        digest = hashlib.sha256()
        with checkpoint.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except (OSError, RuntimeError, ValueError):
        return _failed("checkpoint_missing_or_unreadable", configured)
    if digest.hexdigest() != expected_hash:
        return _failed("checkpoint_hash_mismatch", configured)

    return {
        "bundle_present": True,
        "bundle_verified": True,
        "runtime_loaded": False,
        "production_approved": False,
        "bundle_id": manifest["bundle_id"],
        "sample_rate": feature.sample_rate,
        "language": "fa",
        "checkpoint_path": str(checkpoint),
        "bundle_directory": configured,
        "reason": "joint_checkpoint_hash_and_model_contract_verified",
    }
