from __future__ import annotations

import unittest
from pydantic import ValidationError

from model_config import validate_acoustic_model_config
from phoneme_inventory import INVENTORY_VERSION


def valid_config() -> dict:
    return {
        "schema_version": "mehran.svs.acoustic-config.v1",
        "config_id": "mehran-fa-logmel-48k-v1",
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
    }


class AcousticModelConfigTests(unittest.TestCase):
    def assert_invalid(self, payload, message=None):
        with self.assertRaises(ValidationError) as error:
            validate_acoustic_model_config(payload)
        if message:
            self.assertIn(message, str(error.exception))

    def test_valid_config_has_deterministic_frame_rate(self):
        config = validate_acoustic_model_config(valid_config())
        self.assertEqual(config.frame_rate_hz, 187.5)
        self.assertEqual(config.target_features, ["log_mel", "f0_hz", "voicing_mask", "log_rms"])

    def test_rejects_wrong_phoneme_inventory_version(self):
        payload = valid_config()
        payload["phoneme_inventory_version"] = "unknown"
        self.assert_invalid(payload, "inventory version")

    def test_rejects_fmax_above_nyquist(self):
        payload = valid_config()
        payload["f_max_hz"] = 25000.0
        self.assert_invalid(payload, "Nyquist")

    def test_rejects_invalid_fft_window_geometry(self):
        payload = valid_config()
        payload["win_length"] = 4096
        self.assert_invalid(payload, "win_length")

    def test_rejects_hop_longer_than_window(self):
        payload = valid_config()
        payload["hop_length"] = 4096
        self.assert_invalid(payload, "hop_length")

    def test_rejects_missing_or_duplicate_target_features(self):
        payload = valid_config()
        payload["target_features"] = ["log_mel", "f0_hz", "f0_hz", "log_rms"]
        self.assert_invalid(payload, "target_features")

    def test_rejects_unknown_fields(self):
        payload = valid_config()
        payload["speaker_embedding_size"] = 256
        self.assert_invalid(payload)

    def test_rejects_unknown_schema(self):
        payload = valid_config()
        payload["schema_version"] = "v9"
        self.assert_invalid(payload)


if __name__ == "__main__":
    unittest.main()
