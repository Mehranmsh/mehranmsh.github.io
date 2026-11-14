from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path

from model_architecture import SingingNetworkConfig
from model_config import validate_acoustic_model_config
from phoneme_inventory import INVENTORY_VERSION
from waveform_decoder import WaveformDecoderConfig
from joint_model_bundle import MANIFEST_NAME, inspect_joint_singing_bundle


def feature_config():
    return validate_acoustic_model_config({
        "schema_version": "mehran.svs.acoustic-config.v1",
        "config_id": "mehran-fa-joint-bundle-test-v1",
        "language": "fa",
        "phoneme_inventory_version": INVENTORY_VERSION,
        "sample_rate": 48000,
        "n_fft": 2048,
        "win_length": 2048,
        "hop_length": 256,
        "mel_bins": 100,
        "f_min_hz": 40.0,
        "f_max_hz": 16000.0,
        "mel_scale": "slaney",
        "mel_normalization": "slaney",
        "log_floor": 1e-5,
        "frame_alignment": "centered",
        "note_pitch_encoding": "midi_0_127",
        "pitch_track_encoding": "continuous_hz_plus_voicing_mask",
        "energy_track_encoding": "log_rms",
        "target_features": ["log_mel", "f0_hz", "voicing_mask", "log_rms"],
    })


class JointModelBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "pipeline.pt").write_bytes(b"joint-checkpoint")
        self.manifest = {
            "schema_version": "mehran.svs.joint-bundle.v1",
            "bundle_id": "mehran-fa-joint-test",
            "task": "singing_voice_synthesis",
            "languages": ["fa"],
            "sample_rate": 48000,
            "acoustic_feature_config": feature_config().model_dump(mode="json"),
            "acoustic_model_config": asdict(SingingNetworkConfig()),
            "waveform_decoder_config": asdict(WaveformDecoderConfig()),
            "pipeline_checkpoint": {
                "path": "pipeline.pt",
                "sha256": hashlib.sha256((self.root / "pipeline.pt").read_bytes()).hexdigest(),
            },
        }
        self.write()

    def tearDown(self):
        self.temp.cleanup()

    def write(self):
        (self.root / MANIFEST_NAME).write_text(json.dumps(self.manifest), encoding="utf-8")

    def test_verifies_joint_checkpoint_without_approving_production(self):
        result = inspect_joint_singing_bundle(self.root)
        self.assertTrue(result["bundle_verified"])
        self.assertFalse(result["runtime_loaded"])
        self.assertFalse(result["production_approved"])
        self.assertEqual(result["language"], "fa")

    def test_rejects_hash_mismatch_and_path_traversal(self):
        self.manifest["pipeline_checkpoint"]["sha256"] = "0" * 64
        self.write()
        self.assertEqual(inspect_joint_singing_bundle(self.root)["reason"], "checkpoint_hash_mismatch")
        self.manifest["pipeline_checkpoint"]["path"] = "../pipeline.pt"
        self.write()
        self.assertEqual(inspect_joint_singing_bundle(self.root)["reason"], "unsafe_checkpoint_path")

    def test_rejects_symlink_checkpoint(self):
        (self.root / "linked.pt").symlink_to(self.root / "pipeline.pt")
        self.manifest["pipeline_checkpoint"]["path"] = "linked.pt"
        self.write()
        self.assertEqual(inspect_joint_singing_bundle(self.root)["reason"], "checkpoint_symlink_rejected")

    def test_rejects_decoder_contract_mismatch(self):
        self.manifest["waveform_decoder_config"]["hop_length"] = 128
        self.manifest["waveform_decoder_config"]["upsample_factors"] = [4, 4, 4, 2]
        self.write()
        self.assertEqual(inspect_joint_singing_bundle(self.root)["reason"], "model_config_contract_mismatch")


if __name__ == "__main__":
    unittest.main()
