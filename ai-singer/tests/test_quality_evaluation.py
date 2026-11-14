from __future__ import annotations

import unittest
import numpy as np

from quality_evaluation import QualityEvaluationError, evaluate_singing_output


def evaluate(ref_wave=None, gen_wave=None, ref_f0=None, gen_f0=None, ref_voice=None, gen_voice=None):
    frames = 12
    wave = np.sin(np.arange(4096) * 2 * np.pi * 220 / 48000).astype(np.float64) * 0.2
    f0 = np.full(frames, 220.0)
    voice = np.ones(frames)
    mel = np.full((frames, 40), -4.0)
    rms = np.full(frames, -2.0)
    return evaluate_singing_output(
        reference_waveform=wave if ref_wave is None else ref_wave,
        generated_waveform=wave.copy() if gen_wave is None else gen_wave,
        reference_f0_hz=f0 if ref_f0 is None else ref_f0,
        generated_f0_hz=f0.copy() if gen_f0 is None else gen_f0,
        reference_voicing=voice if ref_voice is None else ref_voice,
        generated_voicing=voice.copy() if gen_voice is None else gen_voice,
        reference_log_mel=mel,
        generated_log_mel=mel.copy(),
        reference_log_rms=rms,
        generated_log_rms=rms.copy(),
        sample_rate=48000,
        hop_length=256,
        spectral_fft_sizes=(128, 256),
    )


class QualityEvaluationTests(unittest.TestCase):
    def test_identical_output_has_zero_error_and_perfect_voicing(self):
        report = evaluate()
        self.assertAlmostEqual(report["f0_cents_rmse"], 0.0)
        self.assertAlmostEqual(report["log_mel_mae"], 0.0)
        self.assertGreater(report["waveform_snr_db"], 200.0)
        self.assertAlmostEqual(report["voiced_frame_f1"], 1.0)
        self.assertFalse(report["quality_passed"])
        self.assertFalse(report["quality_thresholds_configured"])

    def test_reports_pitch_error_in_cents(self):
        shifted = np.full(12, 440.0)
        report = evaluate(gen_f0=shifted)
        self.assertAlmostEqual(report["f0_cents_rmse"], 1200.0, delta=0.01)

    def test_reports_voicing_misses(self):
        generated = np.zeros(12)
        report = evaluate(gen_voice=generated)
        self.assertEqual(report["voiced_frame_recall"], 0.0)
        self.assertEqual(report["voiced_frame_f1"], 0.0)

    def test_rejects_mismatched_waveform_lengths(self):
        with self.assertRaisesRegex(QualityEvaluationError, "identical lengths"):
            evaluate(gen_wave=np.zeros(10))

    def test_rejects_unaligned_feature_tracks(self):
        with self.assertRaisesRegex(QualityEvaluationError, "frame-aligned"):
            evaluate(gen_f0=np.full(11, 220.0))

    def test_rejects_non_finite_audio(self):
        invalid = np.zeros(4096)
        invalid[0] = np.nan
        with self.assertRaisesRegex(QualityEvaluationError, "finite"):
            evaluate(ref_wave=invalid)


if __name__ == "__main__":
    unittest.main()
