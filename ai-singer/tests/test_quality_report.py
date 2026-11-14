import unittest

from quality_evaluation import evaluate_singing_output
from quality_report import QualitySummaryError, summarize_quality_reports


def report(frames=100, duration=1.0, **overrides):
    base = {
        "schema_version": "mehran.svs.quality-report.v1",
        "sample_rate": 48000,
        "hop_length": 256,
        "frames_evaluated": frames,
        "duration_seconds": duration,
        "voiced_frame_precision": 0.9,
        "voiced_frame_recall": 0.8,
        "voiced_frame_f1": 0.85,
        "f0_cents_rmse": 25.0,
        "f0_voiced_frame_coverage": 0.95,
        "log_mel_mae": 0.2,
        "log_rms_mae": 0.1,
        "waveform_snr_db": 18.0,
        "multi_resolution_spectral_convergence": 0.3,
        "multi_resolution_log_magnitude_mae": 0.4,
        "peak_amplitude": 0.8,
        "clipped_sample_fraction": 0.0,
    }
    base.update(overrides)
    return base


class QualityReportTests(unittest.TestCase):
    def test_aggregates_macro_weighted_and_percentile_metrics(self):
        summary = summarize_quality_reports([
            report(frames=100, duration=1.0, f0_cents_rmse=10.0),
            report(frames=300, duration=3.0, f0_cents_rmse=30.0),
        ])
        metric = summary["metrics"]["f0_cents_rmse"]
        self.assertEqual(summary["recordings_evaluated"], 2)
        self.assertEqual(summary["total_frames_evaluated"], 400)
        self.assertEqual(summary["total_duration_seconds"], 4.0)
        self.assertEqual(metric["macro_mean"], 20.0)
        self.assertEqual(metric["frame_weighted_mean"], 25.0)
        self.assertEqual(metric["p50"], 20.0)
        self.assertEqual(metric["p90"], 28.0)
        self.assertFalse(summary["quality_passed"])
        self.assertTrue(summary["human_listening_review_required"])

    def test_omits_unavailable_metric_values_without_fabricating_zero(self):
        summary = summarize_quality_reports([
            report(f0_cents_rmse=None),
            report(f0_cents_rmse=None),
        ])
        self.assertIsNone(summary["metrics"]["f0_cents_rmse"]["macro_mean"])
        self.assertEqual(summary["metrics"]["f0_cents_rmse"]["recordings_available"], 0)

    def test_rejects_empty_input(self):
        with self.assertRaises(QualitySummaryError):
            summarize_quality_reports([])

    def test_rejects_mixed_audio_contracts(self):
        with self.assertRaisesRegex(QualitySummaryError, "share sample_rate"):
            summarize_quality_reports([report(), report(sample_rate=24000)])

    def test_rejects_non_finite_metrics(self):
        with self.assertRaisesRegex(QualitySummaryError, "finite"):
            summarize_quality_reports([report(waveform_snr_db=float("nan"))])

    def test_does_not_copy_identifiers_or_extra_fields(self):
        source = report(speaker_id="private-speaker", recording_id="private-recording",
                        transcript="private words")
        summary = summarize_quality_reports([source])
        rendered = repr(summary)
        self.assertNotIn("private-speaker", rendered)
        self.assertNotIn("private-recording", rendered)
        self.assertNotIn("private words", rendered)


if __name__ == "__main__":
    unittest.main()
