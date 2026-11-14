"""Compare two verified MEHRAN singing bundles on the exact same local test examples.

The test split is loaded once and reused for both models. Only aggregate metrics and
bundle identifiers are emitted; no audio, speaker IDs, transcripts, or paths leave
the local process. This comparison never approves a model.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from dataset_loader import load_training_examples
from heldout_evaluation import evaluate_heldout_examples, HeldoutEvaluationError
from inference_runtime import SingingInferenceRuntime
from joint_model_bundle import inspect_joint_singing_bundle, MANIFEST_NAME
from model_config import AcousticModelConfig
from quality_report import METRICS


class ModelComparisonError(ValueError):
    """Raised when two model bundles cannot be compared fairly."""


METRIC_DIRECTIONS = {
    "voiced_frame_precision": "higher",
    "voiced_frame_recall": "higher",
    "voiced_frame_f1": "higher",
    "f0_cents_rmse": "lower",
    "f0_voiced_frame_coverage": "higher",
    "log_mel_mae": "lower",
    "log_rms_mae": "lower",
    "waveform_snr_db": "higher",
    "multi_resolution_spectral_convergence": "lower",
    "multi_resolution_log_magnitude_mae": "lower",
    "clipped_sample_fraction": "lower",
    "peak_amplitude": "informational",
}


def compare_metric_summaries(baseline: dict, candidate: dict) -> dict:
    """Compare aggregate summaries; report direction, never a pass/fail decision."""
    if baseline.get("sample_rate") != candidate.get("sample_rate"):
        raise ModelComparisonError("model summaries use different sample rates")
    if baseline.get("hop_length") != candidate.get("hop_length"):
        raise ModelComparisonError("model summaries use different hop lengths")
    if baseline.get("recordings_evaluated") != candidate.get("recordings_evaluated"):
        raise ModelComparisonError("models were not evaluated on the same number of recordings")

    baseline_metrics = baseline.get("metrics")
    candidate_metrics = candidate.get("metrics")
    if not isinstance(baseline_metrics, dict) or not isinstance(candidate_metrics, dict):
        raise ModelComparisonError("both summaries must contain aggregate metrics")

    results = {}
    for metric in METRICS:
        base = baseline_metrics.get(metric, {}).get("macro_mean")
        cand = candidate_metrics.get(metric, {}).get("macro_mean")
        direction = METRIC_DIRECTIONS[metric]
        if base is None or cand is None:
            status, delta = "insufficient_data", None
        else:
            delta = float(cand) - float(base)
            if direction == "informational":
                status = "informational"
            elif delta == 0:
                status = "no_change"
            elif (delta > 0 and direction == "higher") or (delta < 0 and direction == "lower"):
                status = "improved"
            else:
                status = "regressed"
        results[metric] = {
            "baseline_macro_mean": base,
            "candidate_macro_mean": cand,
            "candidate_minus_baseline": delta,
            "preferred_direction": direction,
            "relative_result": status,
        }

    return {
        "schema_version": "mehran.svs.model-comparison.v1",
        "sample_rate": baseline["sample_rate"],
        "hop_length": baseline["hop_length"],
        "recordings_evaluated": baseline["recordings_evaluated"],
        "metrics": results,
        "quality_passed": False,
        "production_approved": False,
        "note": (
            "Relative metric directions are descriptive only. They are not calibrated quality thresholds, "
            "statistical significance, perceptual approval, or production authorization."
        ),
    }


def _load_verified_manifest(bundle_directory):
    verification = inspect_joint_singing_bundle(bundle_directory)
    if not verification.get("bundle_verified"):
        raise ModelComparisonError("a joint model bundle failed integrity verification")
    root = Path(bundle_directory).expanduser().resolve(strict=True)
    manifest_path = root / MANIFEST_NAME
    raw = manifest_path.read_bytes()
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ModelComparisonError("a verified bundle manifest could not be parsed") from exc
    return root, manifest, hashlib.sha256(raw).hexdigest()


def compare_heldout_bundles(
    manifest_path,
    baseline_bundle,
    candidate_bundle,
    *,
    dataset_root=None,
    device="cpu",
) -> dict:
    """Evaluate two verified bundles on one loaded test split and compare aggregates."""
    baseline_root, baseline_manifest, baseline_hash = _load_verified_manifest(baseline_bundle)
    candidate_root, candidate_manifest, candidate_hash = _load_verified_manifest(candidate_bundle)

    baseline_features = baseline_manifest.get("acoustic_feature_config")
    candidate_features = candidate_manifest.get("acoustic_feature_config")
    if json.dumps(baseline_features, sort_keys=True) != json.dumps(candidate_features, sort_keys=True):
        raise ModelComparisonError("bundles use different acoustic feature configurations")

    feature_config = AcousticModelConfig.model_validate(baseline_features)
    examples = load_training_examples(
        manifest_path,
        feature_config,
        dataset_root=dataset_root,
        split="test",
        require_speaker_references=True,
        include_waveform_targets=True,
    )
    if not examples:
        raise ModelComparisonError("held-out test split contains no target recordings")

    baseline_runtime = SingingInferenceRuntime.from_bundle(baseline_root, device=device)
    candidate_runtime = SingingInferenceRuntime.from_bundle(candidate_root, device=device)
    baseline_summary = evaluate_heldout_examples(examples, baseline_runtime, feature_config)
    candidate_summary = evaluate_heldout_examples(examples, candidate_runtime, feature_config)
    comparison = compare_metric_summaries(baseline_summary, candidate_summary)
    comparison.update({
        "baseline_bundle_id": baseline_manifest["bundle_id"],
        "candidate_bundle_id": candidate_manifest["bundle_id"],
        "test_manifest_sha256": hashlib.sha256(Path(manifest_path).expanduser().read_bytes()).hexdigest(),
        "baseline_bundle_manifest_sha256": baseline_hash,
        "candidate_bundle_manifest_sha256": candidate_hash,
        "same_test_examples_loaded_once": True,
        "evaluation_mode": "same_heldout_test_split_with_ground_truth_phoneme_and_midi_conditioning",
    })
    return comparison


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare two verified MEHRAN singing bundles on the same local held-out test split."
    )
    parser.add_argument("manifest", help="Local consented dataset JSONL manifest")
    parser.add_argument("baseline_bundle", help="Verified baseline bundle directory")
    parser.add_argument("candidate_bundle", help="Verified candidate bundle directory")
    parser.add_argument("--audio-root", help="Root for relative audio paths")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    try:
        result = compare_heldout_bundles(
            args.manifest,
            args.baseline_bundle,
            args.candidate_bundle,
            dataset_root=args.audio_root,
            device=args.device,
        )
    except (ModelComparisonError, HeldoutEvaluationError, ValueError, OSError, RuntimeError) as exc:
        parser.exit(2, f"MODEL COMPARISON NOT COMPLETED: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
