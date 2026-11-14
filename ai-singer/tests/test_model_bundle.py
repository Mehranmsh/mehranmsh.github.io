from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path

from model_architecture import SingingNetworkConfig
from model_config import validate_acoustic_model_config
from model_bundle import inspect_singing_bundle
from phoneme_inventory import INVENTORY_VERSION
from waveform_decoder import WaveformDecoderConfig


def feature_config():
    return validate_acoustic_model_config({
        "schema_version": "mehran.svs.acoustic-config.v1",
        "config_id": "mehran-fa-bundle-test-v1",
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


class ModelBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "acoustic.pt").write_bytes(b"acoustic-checkpoint")
        (self.root / "waveform.pt").write_bytes(b"waveform-checkpoint")
        feature = feature_config()
        self.manifest = {
            "schema_version": "mehran.svs.bundle.v1",
            "bundle_id": "mehran-fa-test-bundle",
            "task": "singing_voice_synthesis",
            "languages": ["fa"],
            "sample_rate": 48000,
            "acoustic_feature_config": feature.model_dump(mode="json"),
            "acoustic_model_config": asdict(SingingNetworkConfig()),
            "waveform_decoder_config": asdict(WaveformDecoderConfig()),
            "acoustic_checkpoint": {
                "path": "acoustic.pt",
                "sha256": hashlib.sha256((self.root / "acoustic.pt").read_bytes()).hexdigest(),
            },
            "waveform_checkpoint": {
                "path": "waveform.pt",
                "sha256": hashlib.sha256((self.root / "waveform.pt").read_bytes()).hexdigest(),
            },
        }
        self.write()

    def tearDown(self):
        self.temp.cleanup()

    def write(self):
        (self.root / "singing-bundle.json").write_text(
            json.dumps(self.manifest), encoding="utf-8"
        )

    def test_verifies_both_checkpoints_without_claiming_inference_ready(self):
        result = inspect_singing_bundle(self.root)
        self.assertTrue(result["bundle_verified"])
        self.assertFalse(result["model_loaded"])
        self.assertFalse(result["inference_ready"])
        self.assertEqual(result["language"], "fa")

    def test_rejects_checkpoint_hash_mismatch(self):
        self.manifest["waveform_checkpoint"]["sha256"] = "0" * 64
        self.write()
        self.assertIn("hash_mismatch", inspect_singing_bundle(self.root)["reason"])

    def test_rejects_path_traversal(self):
        self.manifest["acoustic_checkpoint"]["path"] = "../acoustic.pt"
        self.write()
        self.assertIn("unsafe_checkpoint_path", inspect_singing_bundle(self.root)["reason"])

    def test_rejects_symlink_checkpoint(self):
        (self.root / "linked.pt").symlink_to(self.root / "acoustic.pt")
        self.manifest["acoustic_checkpoint"]["path"] = "linked.pt"
        self.write()
        self.assertIn("symlink_rejected", inspect_singing_bundle(self.root)["reason"])

    def test_rejects_config_contract_mismatch(self):
        self.manifest["waveform_decoder_config"]["hop_length"] = 128
        self.manifest["waveform_decoder_config"]["upsample_factors"] = [4, 4, 4, 2]
        self.write()
        self.assertEqual(
            inspect_singing_bundle(self.root)["reason"], "model_config_contract_mismatch"
        )

    def test_rejects_unknown_manifest_fields(self):
        self.manifest["inference_ready"] = True
        self.write()
        self.assertEqual(inspect_singing_bundle(self.root)["reason"], "manifest_fields_invalid")


if __name__ == "__main__":
    unittest.main()
