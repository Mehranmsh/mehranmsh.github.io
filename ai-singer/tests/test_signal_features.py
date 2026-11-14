from __future__ import annotations

import io
import unittest
import wave

import numpy as np

from model_config import validate_acoustic_model_config
from phoneme_inventory import INVENTORY_VERSION
from signal_features import extract_acoustic_features, read_mono_pcm_wav


def config():
    return validate_acoustic_model_config({
        "schema_version": "mehran.svs.acoustic-config.v1",
        "config_id": "mehran-fa-logmel-test-v1",
        "language": "fa",
        "phoneme_inventory_version": INVENTORY_VERSION,
        "sample_rate": 48000,
        "n_fft": 2048,
        "win_length": 2048,
        "hop_length": 256,
        "mel_bins": 40,
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


def wav_bytes(samples: np.ndarray, rate=48000):
    buffer = io.BytesIO()
    pcm = np.clip(samples, -1, 1)
    encoded = (pcm * 32767).astype("<i2").tobytes()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(encoded)
    return buffer.getvalue()


class SignalFeatureTests(unittest.TestCase):
    def test_extracts_aligned_features_from_tone(self):
        rate = 48000
        time = np.arange(rate // 2, dtype=np.float32) / rate
        audio = 0.3 * np.sin(2 * np.pi * 220.0 * time)
        features = extract_acoustic_features(wav_bytes(audio), config())
        self.assertEqual(features.log_mel.shape[1], 40)
        self.assertEqual(features.f0_hz.shape[0], features.log_mel.shape[0])
        self.assertEqual(features.voicing_mask.shape, features.f0_hz.shape)
        self.assertEqual(features.log_rms.shape, features.f0_hz.shape)
        voiced = features.f0_hz[features.voicing_mask > 0]
        self.assertGreater(voiced.size, 10)
        self.assertAlmostEqual(float(np.median(voiced)), 220.0, delta=8.0)

    def test_silence_has_no_voiced_frames(self):
        features = extract_acoustic_features(wav_bytes(np.zeros(4800, dtype=np.float32)), config())
        self.assertFalse(np.any(features.voicing_mask))
        self.assertTrue(np.all(np.isfinite(features.log_mel)))

    def test_rejects_stereo_and_wrong_sample_rate(self):
        with self.assertRaisesRegex(ValueError, "mono"):
            read_mono_pcm_wav(b"not a wav", 48000)
        with self.assertRaisesRegex(ValueError, "sample rate"):
            read_mono_pcm_wav(wav_bytes(np.zeros(4800), 44100), 48000)

    def test_rejects_corrupt_wav(self):
        with self.assertRaisesRegex(ValueError, "invalid PCM WAV"):
            read_mono_pcm_wav(b"broken", 48000)


if __name__ == "__main__":
    unittest.main()
