import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from model_artifact import inspect_model_artifact


class ModelArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.checkpoint = self.root / "weights.bin"
        self.checkpoint.write_bytes(b"MEHRAN-TEST-CHECKPOINT")
        self.manifest = {
            "schema_version": "mehran.svs.model.v1",
            "model_id": "mehran-persian-svs-001",
            "architecture": "mehran-acoustic-v1",
            "framework": "pytorch",
            "checkpoint": "weights.bin",
            "sha256": hashlib.sha256(self.checkpoint.read_bytes()).hexdigest(),
            "sample_rate": 48000,
            "languages": ["fa"],
            "task": "singing_voice_synthesis",
        }

    def tearDown(self):
        self.temp.cleanup()

    def write_manifest(self):
        (self.root / "model-manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def test_valid_artifact_is_verified_but_not_loaded(self):
        self.write_manifest()
        result = inspect_model_artifact(self.root)
        self.assertTrue(result["artifact_present"])
        self.assertTrue(result["artifact_verified"])
        self.assertFalse(result["model_loaded"])
        self.assertFalse(result["inference_ready"])
        self.assertEqual(result["model_id"], "mehran-persian-svs-001")

    def test_missing_directory_is_unavailable(self):
        result = inspect_model_artifact(self.root / "missing")
        self.assertEqual(result["reason"], "model_directory_missing")

    def test_missing_manifest_is_unavailable(self):
        self.assertEqual(inspect_model_artifact(self.root)["reason"], "manifest_invalid_or_unreadable")

    def test_hash_mismatch_is_rejected(self):
        self.manifest["sha256"] = "0" * 64
        self.write_manifest()
        self.assertEqual(inspect_model_artifact(self.root)["reason"], "checkpoint_hash_mismatch")

    def test_path_traversal_is_rejected(self):
        self.manifest["checkpoint"] = "../weights.bin"
        self.write_manifest()
        self.assertEqual(inspect_model_artifact(self.root)["reason"], "unsafe_checkpoint_path")

    def test_unsupported_schema_is_rejected(self):
        self.manifest["schema_version"] = "v9"
        self.write_manifest()
        self.assertEqual(inspect_model_artifact(self.root)["reason"], "unsupported_manifest_schema")

    def test_invalid_sample_rate_is_rejected(self):
        self.manifest["sample_rate"] = 12345
        self.write_manifest()
        self.assertEqual(inspect_model_artifact(self.root)["reason"], "unsupported_sample_rate")

    def test_duplicate_languages_are_rejected(self):
        self.manifest["languages"] = ["fa", "fa"]
        self.write_manifest()
        self.assertEqual(inspect_model_artifact(self.root)["reason"], "invalid_languages")

    def test_checkpoint_symlink_escape_is_rejected(self):
        outside = self.root.parent / (self.root.name + "-outside.bin")
        outside.write_bytes(b"outside")
        try:
            (self.root / "linked.bin").symlink_to(outside)
            self.manifest["checkpoint"] = "linked.bin"
            self.manifest["sha256"] = hashlib.sha256(b"outside").hexdigest()
            self.write_manifest()
            self.assertEqual(inspect_model_artifact(self.root)["reason"], "checkpoint_missing_or_unreadable")
        finally:
            outside.unlink(missing_ok=True)

    def test_loaded_state_is_never_claimed(self):
        self.write_manifest()
        result = inspect_model_artifact(self.root)
        self.assertIs(result["model_loaded"], False)
        self.assertIs(result["inference_ready"], False)


if __name__ == "__main__":
    unittest.main()
