from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

import heldout_evaluation
from model_config import AcousticModelConfig
from signal_features import AcousticFeatures
from token_encoder import FrameTokenSequence
from pitch_targets import PitchTargets


class FakeRuntime:
    def __init__(self, waveform):
        self.waveform = waveform
        self.calls = 0

    def synthesize(self, *args):
        self.calls += 1
        return self.waveform


def make_example():
    frames = 4
    samples = frames * 256
    audio = np.sin(np.arange(samples) * 2 * np.pi * 220 / 48000).astype(np.float32) * 0.1
    mel = np.full((frames, 40), -4.0, dtype=np.float32)
    acoustic = AcousticFeatures(
        log_mel=mel,
        f0_hz=np.full(frames, 220.0, dtype=np.float32),
        voicing_mask=np.ones(frames, dtype=np.float32),
        log_rms=np.full(frames, -2.0, dtype=np.float32),
        sample_rate=48000,
        hop_length=256,
    )
    tokens = FrameTokenSequence(
        frame_times_seconds=np.arange(frames, dtype=np.float32) * 256 / 48000,
        phoneme_ids=np.ones(frames, dtype=np.int32),
        note_ids=np.full(frames, 70, dtype=np.int32),
        phoneme_mask=np.ones(frames, dtype=np.uint8),
        note_mask=np.ones(frames, dtype=np.uint8),
        phoneme_vocabulary_version="test",
        frame_rate_hz=187.5,
    )
    pitch = PitchTargets(
        frame_times_seconds=tokens.frame_times_seconds,
        f0_hz=np.full(frames, 220.0, dtype=np.float32),
        voicing_mask=np.ones(frames, dtype=np.float32),
        energy=np.ones(frames, dtype=np.float32),
    )
    return SimpleNamespace(
        acoustic=acoustic,
        tokens=tokens,
        pitch_targets=pitch,
        speaker_reference_log_mel=np.full((3, 40), -4.0, dtype=np.float32),
        waveform_target=audio,
        waveform_sample_mask=np.ones(samples, dtype=np.uint8),
    )


class HeldoutEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.config = AcousticModelConfig(
            schema_version="mehran.svs.acoustic-config.v1",
            config_id="test-persian",
            language="fa",
            phoneme_inventory_version="mehran.fa.phonemes.v1",
            sample_rate=48000,
            n_fft=256,
            win_length=256,
            hop_length=256,
            mel_bins=40,
            f_max_hz=16000.0,
        )

    def test_runs_runtime_and_emits_aggregate_only_report(self):
        example = make_example()
        runtime = FakeRuntime(example.waveform_target.copy())
        generated_features = example.acoustic
        with patch.object(heldout_evaluation, "extract_acoustic_features", return_value=generated_features):
            summary = heldout_evaluation.evaluate_heldout_examples([example], runtime, self.config)
        self.assertEqual(runtime.calls, 1)
        self.assertEqual(summary["recordings_evaluated"], 1)
        self.assertTrue(summary["model_bundle_verified"])
        self.assertFalse(summary["quality_passed"])
        self.assertFalse(summary["production_approved"])
        self.assertNotIn("recording_id", repr(summary))
        self.assertNotIn("speaker_id", repr(summary))

    def test_rejects_missing_separate_speaker_reference(self):
        example = make_example()
        example.speaker_reference_log_mel = None
        runtime = FakeRuntime(example.waveform_target.copy())
        with self.assertRaisesRegex(heldout_evaluation.HeldoutEvaluationError, "separate speaker reference"):
            heldout_evaluation.evaluate_heldout_examples([example], runtime, self.config)

    def test_rejects_missing_original_waveform(self):
        example = make_example()
        example.waveform_target = None
        runtime = FakeRuntime(np.zeros(1024, dtype=np.float32))
        with self.assertRaisesRegex(heldout_evaluation.HeldoutEvaluationError, "original waveform"):
            heldout_evaluation.evaluate_heldout_examples([example], runtime, self.config)

    def test_rejects_invalid_sample_mask(self):
        example = make_example()
        example.waveform_sample_mask[0] = 0
        runtime = FakeRuntime(example.waveform_target.copy())
        with self.assertRaisesRegex(heldout_evaluation.HeldoutEvaluationError, "contiguous valid prefix"):
            heldout_evaluation.evaluate_heldout_examples([example], runtime, self.config)

    def test_rejects_short_generated_waveform(self):
        example = make_example()
        runtime = FakeRuntime(np.zeros(100, dtype=np.float32))
        with self.assertRaisesRegex(heldout_evaluation.HeldoutEvaluationError, "shorter"):
            heldout_evaluation.evaluate_heldout_examples([example], runtime, self.config)


if __name__ == "__main__":
    unittest.main()
