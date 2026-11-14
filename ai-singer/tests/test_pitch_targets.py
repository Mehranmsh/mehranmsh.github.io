from __future__ import annotations

import unittest

from acoustic_contract import validate_acoustic_conditioning
from model_config import validate_acoustic_model_config
from phoneme_inventory import INVENTORY_VERSION
from pitch_targets import build_pitch_targets


def model_config():
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


def conditioning(notes, *, duration=1.0, style=None):
    payload = {
        "schema_version": "mehran.svs.conditioning.v1",
        "project_id": "pitch-test",
        "language": "fa",
        "sample_rate": 48000,
        "duration_seconds": duration,
        "phonemes": [{"phoneme": "a", "start_seconds": 0.0, "end_seconds": duration}],
        "notes": notes,
    }
    if style is not None:
        payload["style"] = style
    return validate_acoustic_conditioning(payload)


class PitchTargetTests(unittest.TestCase):
    def test_midi_a4_maps_to_440_hz_and_rest_is_unvoiced(self):
        cond = conditioning([{
            "midi_note": 69, "start_seconds": 0.2,
            "duration_seconds": 0.3, "velocity": 127,
        }])
        targets = build_pitch_targets(cond, model_config())
        active = (targets.frame_times_seconds >= 0.2) & (targets.frame_times_seconds < 0.5)
        self.assertTrue((targets.voicing_mask[active] == 1).all())
        self.assertAlmostEqual(float(targets.f0_hz[active][0]), 440.0, delta=0.01)
        self.assertTrue((targets.voicing_mask[~active] == 0).all())
        self.assertTrue((targets.f0_hz[~active] == 0).all())

    def test_pitch_shift_and_velocity_energy_are_applied(self):
        cond = conditioning([{
            "midi_note": 69, "start_seconds": 0.0,
            "duration_seconds": 0.5, "velocity": 64,
        }], style={"pitch_shift_semitones": 12, "energy": 0.8})
        targets = build_pitch_targets(cond, model_config())
        self.assertAlmostEqual(float(targets.f0_hz[0]), 880.0, delta=0.02)
        self.assertAlmostEqual(float(targets.energy[0]), 0.8 * 64 / 127, delta=1e-5)

    def test_rejects_overlapping_notes_for_monophonic_voice(self):
        cond = conditioning([
            {"midi_note": 60, "start_seconds": 0.0, "duration_seconds": 0.4},
            {"midi_note": 64, "start_seconds": 0.3, "duration_seconds": 0.3},
        ])
        with self.assertRaisesRegex(ValueError, "monophonic"):
            build_pitch_targets(cond, model_config())

    def test_rejects_config_rate_mismatch(self):
        cond = conditioning([{
            "midi_note": 60, "start_seconds": 0.0, "duration_seconds": 0.5,
        }])
        wrong = model_config().model_copy(update={"sample_rate": 44100})
        with self.assertRaisesRegex(ValueError, "sample rate"):
            build_pitch_targets(cond, wrong)


if __name__ == "__main__":
    unittest.main()
