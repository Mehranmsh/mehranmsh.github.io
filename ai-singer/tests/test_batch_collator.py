from __future__ import annotations

import unittest

import numpy as np

from acoustic_contract import validate_acoustic_conditioning
from batch_collator import TrainingExample, collate_training_examples
from model_config import validate_acoustic_model_config
from phoneme_inventory import INVENTORY_VERSION
from pitch_targets import build_pitch_targets
from signal_features import AcousticFeatures
from token_encoder import build_frame_token_sequence


def config():
    return validate_acoustic_model_config({
        "schema_version": "mehran.svs.acoustic-config.v1",
        "config_id": "mehran-fa-batch-test-v1",
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


def example(recording_id, duration):
    cfg = config()
    phonemes = [{"phoneme": "æ", "start_seconds": 0.0, "end_seconds": duration}]
    notes = [{"midi_note": 69, "start_seconds": 0.0, "duration_seconds": duration}]
    cond = validate_acoustic_conditioning({
        "schema_version": "mehran.svs.conditioning.v1",
        "project_id": recording_id,
        "language": "fa",
        "sample_rate": 48000,
        "duration_seconds": duration,
        "phonemes": phonemes,
        "notes": notes,
    })
    tokens = build_frame_token_sequence(cond, cfg)
    pitch = build_pitch_targets(cond, cfg)
    frames = len(tokens.frame_times_seconds)
    acoustic = AcousticFeatures(
        log_mel=np.full((frames, cfg.mel_bins), -10.0, dtype=np.float32),
        f0_hz=np.full(frames, 440.0, dtype=np.float32),
        voicing_mask=np.ones(frames, dtype=np.float32),
        log_rms=np.full(frames, -2.0, dtype=np.float32),
        sample_rate=cfg.sample_rate,
        hop_length=cfg.hop_length,
    )
    return TrainingExample(recording_id, acoustic, tokens, pitch)


class BatchCollatorTests(unittest.TestCase):
    def test_pads_batch_and_preserves_lengths_and_masks(self):
        cfg = config()
        batch = collate_training_examples(
            [example("short", 0.1), example("long", 0.2)],
            cfg,
            pad_to_multiple_of=8,
        )
        self.assertEqual(batch.target_log_mel.shape[0], 2)
        self.assertEqual(batch.target_log_mel.shape[2], cfg.mel_bins)
        self.assertEqual(batch.target_log_mel.shape[1] % 8, 0)
        self.assertLess(batch.lengths[0], batch.lengths[1])
        self.assertEqual(int(batch.valid_frame_mask[0].sum()), int(batch.lengths[0]))
        self.assertTrue((batch.valid_frame_mask[0, batch.lengths[0]:] == 0).all())
        self.assertTrue((batch.target_f0_hz[0, batch.lengths[0]:] == 0).all())
        self.assertAlmostEqual(float(batch.target_log_mel[0, -1, 0]), float(np.log(cfg.log_floor)), places=5)

    def test_rejects_empty_batch(self):
        with self.assertRaisesRegex(ValueError, "at least one"):
            collate_training_examples([], config())

    def test_rejects_misaligned_frame_tracks(self):
        item = example("bad", 0.1)
        broken = AcousticFeatures(
            log_mel=item.acoustic.log_mel,
            f0_hz=item.acoustic.f0_hz[:-1],
            voicing_mask=item.acoustic.voicing_mask,
            log_rms=item.acoustic.log_rms,
            sample_rate=item.acoustic.sample_rate,
            hop_length=item.acoustic.hop_length,
        )
        bad = TrainingExample(item.recording_id, broken, item.tokens, item.pitch_targets)
        with self.assertRaisesRegex(ValueError, "share one non-empty frame axis"):
            collate_training_examples([bad], config())

    def test_rejects_batch_over_frame_limit(self):
        with self.assertRaisesRegex(ValueError, "max_frames"):
            collate_training_examples([example("long", 0.2)], config(), max_frames=10)


if __name__ == "__main__":
    unittest.main()
