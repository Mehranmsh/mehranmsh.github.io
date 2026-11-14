from __future__ import annotations

import unittest
from dataclasses import replace

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


def example(recording_id, duration, reference_frames=None):
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
    reference = None if reference_frames is None else np.full((reference_frames, cfg.mel_bins), -8.0, dtype=np.float32)
    return TrainingExample(recording_id, acoustic, tokens, pitch, speaker_reference_log_mel=reference)


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
        self.assertTrue(np.array_equal(batch.phoneme_mask[0, :batch.lengths[0]], batch.phoneme_ids[0, :batch.lengths[0]] != 0))
        self.assertTrue(np.array_equal(batch.note_mask[0, :batch.lengths[0]], batch.note_ids[0, :batch.lengths[0]] != 0))
        self.assertTrue((batch.valid_frame_mask[0, batch.lengths[0]:] == 0).all())
        self.assertTrue((batch.target_f0_hz[0, batch.lengths[0]:] == 0).all())
        self.assertAlmostEqual(float(batch.target_log_mel[0, -1, 0]), float(np.log(cfg.log_floor)), places=5)

    def test_pads_reference_audio_and_builds_reference_mask(self):
        batch = collate_training_examples(
            [example("ref-short", 0.1, 5), example("ref-long", 0.2, 9)], config()
        )
        self.assertEqual(batch.speaker_reference_log_mel.shape, (2, 9, config().mel_bins))
        self.assertEqual(batch.speaker_reference_frame_mask.tolist(), [[1]*5+[0]*4, [1]*9])

    def test_rejects_mixed_reference_presence(self):
        with self.assertRaisesRegex(ValueError, "all examples"):
            collate_training_examples(
                [example("with-ref", 0.1, 5), example("without-ref", 0.1)], config()
            )

    def test_collates_waveforms_with_sample_masks(self):
        first = example("wave-a", 0.1)
        second = example("wave-b", 0.2)
        prepared = []
        for item, valid_count in ((first, 4800), (second, 9600)):
            total = len(item.acoustic.f0_hz) * config().hop_length
            prepared.append(replace(
                item,
                waveform_target=np.full(total, 0.125, dtype=np.float32),
                waveform_sample_mask=np.r_[
                    np.ones(valid_count, dtype=np.uint8),
                    np.zeros(total-valid_count, dtype=np.uint8),
                ],
            ))
        batch = collate_training_examples(prepared, config())
        self.assertEqual(batch.waveform_target.shape, (2, batch.target_log_mel.shape[1] * config().hop_length))
        self.assertEqual(int(batch.waveform_sample_mask[0].sum()), 4800)
        self.assertEqual(int(batch.waveform_sample_mask[1].sum()), 9600)
        self.assertTrue(np.all(batch.waveform_target[0, 4800:] == 0))
        self.assertTrue(np.all(batch.waveform_sample_mask[0, 4800:] == 0))

    def test_rejects_mixed_waveform_target_presence(self):
        base = example("wave-present", 0.1)
        total = len(base.acoustic.f0_hz) * config().hop_length
        first = replace(base, waveform_target=np.zeros(total, dtype=np.float32),
                        waveform_sample_mask=np.ones(total, dtype=np.uint8))
        with self.assertRaisesRegex(ValueError, "all examples"):
            collate_training_examples([first, example("wave-missing", 0.1)], config())

    def test_rejects_waveform_target_length_mismatch(self):
        item = replace(example("wave-bad", 0.1),
                        waveform_target=np.zeros(10, dtype=np.float32),
                        waveform_sample_mask=np.ones(10, dtype=np.uint8))
        with self.assertRaisesRegex(ValueError, "length must equal"):
            collate_training_examples([item], config())

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

    def test_rejects_inconsistent_phoneme_mask(self):
        item = example("bad-mask", 0.1)
        item.tokens.phoneme_mask[0] = 0
        with self.assertRaisesRegex(ValueError, "phoneme mask"):
            collate_training_examples([item], config())

    def test_rejects_voicing_mask_inconsistent_with_f0(self):
        item = example("bad-f0", 0.1)
        item.acoustic.voicing_mask[0] = 0
        with self.assertRaisesRegex(ValueError, "voicing mask"):
            collate_training_examples([item], config())

    def test_rejects_duplicate_recording_ids(self):
        item = example("duplicate", 0.1)
        with self.assertRaisesRegex(ValueError, "unique"):
            collate_training_examples([item, item], config())

    def test_rejects_batch_over_frame_limit(self):
        with self.assertRaisesRegex(ValueError, "max_frames"):
            collate_training_examples([example("long", 0.2)], config(), max_frames=10)


if __name__ == "__main__":
    unittest.main()
