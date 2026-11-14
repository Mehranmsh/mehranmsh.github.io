from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import model_comparison
from quality_report import METRICS


def make_summary(value=1.0):
    metrics = {}
    for name in METRICS:
        metrics[name] = {
            "macro_mean": value,
            "frame_weighted_mean": value,
            "p50": value,
            "p90": value,
        }
    return {
        "sample_rate": 48000,
        "hop_length": 256,
        "recordings_evaluated": 3,
        "metrics": metrics,
    }


class ModelComparisonTests(unittest.TestCase):
    def test_reports_relative_direction_without_approval(self):
        baseline = make_summary(2.0)
        candidate = make_summary(1.0)
        result = model_comparison.compare_metric_summaries(baseline, candidate)
        self.assertEqual(result["metrics"]["f0_cents_rmse"]["relative_result"], "improved")
        self.assertEqual(result["metrics"]["voiced_frame_f1"]["relative_result"], "regressed")
        self.assertEqual(result["metrics"]["peak_amplitude"]["relative_result"], "informational")
        self.assertFalse(result["quality_passed"])
        self.assertFalse(result["production_approved"])

    def test_rejects_different_sample_rates(self):
        baseline = make_summary()
        candidate = make_summary()
        candidate["sample_rate"] = 44100
        with self.assertRaisesRegex(model_comparison.ModelComparisonError, "sample rates"):
            model_comparison.compare_metric_summaries(baseline, candidate)

    def test_rejects_different_recording_counts(self):
        baseline = make_summary()
        candidate = make_summary()
        candidate["recordings_evaluated"] = 2
        with self.assertRaisesRegex(model_comparison.ModelComparisonError, "same number"):
            model_comparison.compare_metric_summaries(baseline, candidate)

    def test_missing_metric_is_not_treated_as_zero(self):
        baseline = make_summary()
        candidate = make_summary()
        baseline["metrics"]["f0_cents_rmse"]["macro_mean"] = None
        result = model_comparison.compare_metric_summaries(baseline, candidate)
        self.assertEqual(result["metrics"]["f0_cents_rmse"]["relative_result"], "insufficient_data")
        self.assertIsNone(result["metrics"]["f0_cents_rmse"]["candidate_minus_baseline"])

    def test_missing_metric_object_is_treated_as_insufficient_data(self):
        baseline = make_summary()
        candidate = make_summary()
        baseline["metrics"]["f0_cents_rmse"] = None
        result = model_comparison.compare_metric_summaries(baseline, candidate)
        self.assertEqual(result["metrics"]["f0_cents_rmse"]["relative_result"], "insufficient_data")

    def test_rejects_non_finite_metric_values(self):
        baseline = make_summary()
        candidate = make_summary()
        baseline["metrics"]["f0_cents_rmse"]["macro_mean"] = float("nan")
        with self.assertRaisesRegex(model_comparison.ModelComparisonError, "finite"):
            model_comparison.compare_metric_summaries(baseline, candidate)

    def test_bundle_comparison_loads_test_examples_once_for_both_models(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "base"
            cand = Path(directory) / "candidate"
            base.mkdir()
            cand.mkdir()
            feature = {
                "schema_version": "mehran.svs.acoustic-config.v1",
                "config_id": "test-fa",
                "language": "fa",
                "phoneme_inventory_version": "mehran.fa.phonemes.v1",
                "sample_rate": 48000,
                "n_fft": 256,
                "win_length": 256,
                "hop_length": 256,
                "mel_bins": 40,
                "f_max_hz": 16000.0,
            }
            base_manifest = {"acoustic_feature_config": feature, "bundle_id": "model-test"}
            candidate_manifest = {"acoustic_feature_config": feature, "bundle_id": "model-candidate"}
            (base / "joint-singing-bundle.json").write_text(json.dumps(base_manifest), encoding="utf-8")
            (cand / "joint-singing-bundle.json").write_text(json.dumps(candidate_manifest), encoding="utf-8")
            examples = [object()]
            manifest_file = Path(directory) / "manifest.jsonl"
            manifest_file.write_text('{"split":"test"}\\n', encoding="utf-8")
            summaries = [make_summary(2.0), make_summary(1.0)]
            with (
                patch.object(model_comparison, "inspect_joint_singing_bundle", return_value={"bundle_verified": True}),
                patch.object(model_comparison, "load_training_examples", return_value=examples) as loader,
                patch.object(model_comparison.SingingInferenceRuntime, "from_bundle", side_effect=[object(), object()]),
                patch.object(model_comparison, "evaluate_heldout_examples", side_effect=summaries),
            ):
                result = model_comparison.compare_heldout_bundles(manifest_file, base, cand)
            self.assertEqual(loader.call_count, 1)
            self.assertTrue(result["same_test_examples_loaded_once"])
            self.assertEqual(result["baseline_bundle_id"], "model-test")
            self.assertEqual(result["candidate_bundle_id"], "model-candidate")
            self.assertFalse(result["production_approved"])

    def test_rejects_feature_contract_mismatch_before_loading_dataset(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "base"
            cand = Path(directory) / "candidate"
            base.mkdir()
            cand.mkdir()
            feature = {
                "schema_version": "mehran.svs.acoustic-config.v1",
                "config_id": "test-fa",
                "language": "fa",
                "phoneme_inventory_version": "mehran.fa.phonemes.v1",
                "sample_rate": 48000,
                "n_fft": 256,
                "win_length": 256,
                "hop_length": 256,
                "mel_bins": 40,
                "f_max_hz": 16000.0,
            }
            for folder, config_id in ((base, "test-fa"), (cand, "different")):
                payload = {"bundle_id": folder.name, "acoustic_feature_config": dict(feature, config_id=config_id)}
                (folder / "joint-singing-bundle.json").write_text(json.dumps(payload), encoding="utf-8")
            with (
                patch.object(model_comparison, "inspect_joint_singing_bundle", return_value={"bundle_verified": True}),
                patch.object(model_comparison, "load_training_examples") as loader,
            ):
                with self.assertRaisesRegex(model_comparison.ModelComparisonError, "different acoustic feature"):
                    model_comparison.compare_heldout_bundles("manifest.jsonl", base, cand)
            loader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
