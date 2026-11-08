"""Strict, offline validation of locally installed music model manifests."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

CATALOG_PATH = Path(__file__).with_name("model_catalog.json")
CATALOG = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
APPROVED = {
    item["id"]: item for item in CATALOG["models"]
    if item.get("status") == "candidate_not_installed"
    and item.get("license") in CATALOG["policy"]["allowed_weight_licenses"]
}

def _inside(parent: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(parent)
        return True
    except ValueError:
        return False

def validate_manifest(models_root: Path, manifest_path: Path | None = None) -> dict:
    models_root = models_root.resolve()
    manifest_path = (manifest_path or (models_root / "runtime.json")).resolve()
    try:
        if not _inside(models_root, manifest_path):
            raise ValueError("Manifest path escapes local models directory.")
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Manifest must be a JSON object.")
        if data.get("enabled") is not True or data.get("runtime") != "local":
            raise ValueError("Runtime must be explicitly enabled and local.")
        model = APPROVED.get(data.get("model_id"))
        if model is None:
            raise ValueError("Model is not on the approved candidate allowlist.")
        if data.get("license") != model["license"]:
            raise ValueError("Declared license does not match the catalog.")
        if data.get("license_reviewed") is not True:
            raise ValueError("Exact model and auxiliary weight licenses have not been reviewed.")
        if data.get("owner_approved") is not True:
            raise ValueError("Owner approval is required before enabling a model.")
        artifacts = data.get("artifacts")
        if not isinstance(artifacts, list) or not artifacts:
            raise ValueError("At least one SHA-256-verified local artifact is required.")
        checked = []
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                raise ValueError("Invalid artifact record.")
            rel, expected = artifact.get("path"), artifact.get("sha256")
            if not isinstance(rel, str) or not rel or not isinstance(expected, str) or len(expected) != 64:
                raise ValueError("Each artifact needs a relative path and SHA-256.")
            target = (models_root / rel).resolve()
            if not _inside(models_root, target) or not target.is_file():
                raise ValueError("Artifact is missing or escapes local models directory.")
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            if digest.lower() != expected.lower():
                raise ValueError("Artifact SHA-256 mismatch.")
            checked.append({"path": rel, "sha256": digest})
        if data.get("self_test_passed") is not True:
            raise ValueError("Model self-test has not passed.")
        return {"valid": True, "model_id": model["id"], "license": model["license"],
                "verified_artifacts": len(checked),
                "message": "Manifest, owner approval, local artifacts, hashes and self-test are valid."}
    except Exception as exc:
        return {"valid": False, "message": str(exc)}
