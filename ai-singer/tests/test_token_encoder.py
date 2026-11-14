from __future__ import annotations

import unittest

from acoustic_contract import validate_acoustic_conditioning
from model_config import validate_acoustic_model_config
from phoneme_inventory import INVENTORY_VERSION
from token_encoder import PHONEME_TO_ID, build_frame_token_sequence


def config():
    return validate_acoustic_model_config({
        "schema_version": "mehran.svs.acoustic-config.v1",
        "config_id": "mehran-fa-token-test-v1",
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


def conditioning(*, language="fa", phonemes=None, notes=None):
    return validate_acoustic_conditioning({
        "schema_version": "mehran.svs.conditioning.v1",
        "project_id": "token-test",
        "language": language,
        "sample_rate": 48000,
        "duration_seconds": 0.5,
        "phonemes": phonemes or [
            {"phoneme": "æ", "start_seconds": 0.0, "end_seconds": 0.25},
            {"phoneme": "m", "start_seconds": 0.25, "end_seconds": 0.5},
        ],
        "notes": notes or [
            {"midi_note": 69, "start_seconds": 0.0, "duration_seconds": 0.3},
            {"midi_note": 72, "start_seconds": 0.3, "duration_seconds": 0.2},
        ],
    })


class TokenEncoderTests(unittest.TestCase):
    def test_encodes_phonemes_and_notes_on_same_frame_grid(self):
        result = build_frame_token_sequence(conditioning(), config())
        self.assertEqual(len(result.frame_times_seconds), len(result.phoneme_ids))
        self.assertEqual(len(result.frame_times_seconds), len(result.note_ids))
        self.assertEqual(int(result.phoneme_ids[0]), PHONEME_TO_ID["æ"])
        self.assertEqual(int(result.note_ids[0]), 70)
        self.assertEqual(int(result.note_ids[-1]), 0)
        self.assertEqual(result.phoneme_vocabulary_version, INVENTORY_VERSION)

    def test_silence_gaps_use_zero_and_masks(self):
        cond = conditioning(
            phonemes=[{"phoneme": "æ", "start_seconds": 0.1, "end_seconds": 0.2}],
            notes=[{"midi_note": 60, "start_seconds": 0.1, "duration_seconds": 0.2}],
        )
        result = build_frame_token_sequence(cond, config())
        before = result.frame_times_seconds < 0.1
        self.assertTrue((result.phoneme_ids[before] == 0).all())
        self.assertTrue((result.note_ids[before] == 0).all())
        self.assertTrue((result.phoneme_mask[before] == 0).all())
        self.assertTrue((result.note_mask[before] == 0).all())

    def test_rejects_non_persian_language(self):
        cond = conditioning(language="en")
        with self.assertRaisesRegex(ValueError, "Persian"):
            build_frame_token_sequence(cond, config())

    def test_rejects_sample_rate_mismatch(self):
        cond = conditioning()
        wrong = config().model_copy(update={"sample_rate": 44100})
        with self.assertRaisesRegex(ValueError, "sample rates"):
            build_frame_token_sequence(cond, wrong)


if __name__ == "__main__":
    unittest.main()
