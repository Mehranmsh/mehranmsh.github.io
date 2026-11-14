"""Run a local, leakage-aware held-out evaluation of a verified MEHRAN SVS bundle.

Only aggregate metrics are printed. Audio, speaker IDs, recording IDs, transcripts,
and local paths are never emitted or uploaded.
"""
from __future__ import annotations

import argparse
import io
import json
import wave
from pathlib import Path

import numpy as np

from dataset_loader import load_training_examples
from joint_model_bundle import inspect_joint_singing_bundle, MANIFEST_NAME
from model_config import AcousticModelConfig
from quality_evaluation import evaluate_singing_output
from quality_report import summarize_quality_reports
from signal_features import extract_acoustic_features
from inference_runtime import SingingInferenceRuntime


class HeldoutEvaluationError(ValueError):
    """Raised when a safe held-out evaluation cannot be completed."""


def _float_wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    audio = np.asarray(samples, dtype=np.float32)
    if audio.ndim != 1 or audio.size == 0 or not np.isfinite(audio).all():
        raise HeldoutEvaluationError("generated audio is empty or invalid")
    if np.any(np.abs(audio) > 1.00001):
        raise HeldoutEvaluationError("generated audio is outside normalized PCM range")
    pcm = np.rint(np.clip(audio, -1.0, 1.0) * 2147483647.0).astype("<i4")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(4)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())
    return buffer.getvalue()


def evaluate_heldout_examples(examples, runtime, feature_config: AcousticModelConfig) -> dict:
    """Synthesize test-split examples and aggregate metrics without identifiers."""
    if not examples:
        raise HeldoutEvaluationError("held-out test split contains no target recordings")
    reports = []
    for example in examples:
        if example.speaker_reference_log_mel is None:
            raise HeldoutEvaluationError("every held-out target requires a separate speaker reference")
        if example.waveform_target is None or example.waveform_sample_mask is None:
            raise HeldoutEvaluationError("held-out targets must include their original waveform")
        mask = np.asarray(example.waveform_sample_mask)
        target = np.asarray(example.waveform_target, dtype=np.float32)
        if mask.ndim != 1 or target.ndim != 1 or mask.size != target.size:
            raise HeldoutEvaluationError("held-out waveform and sample mask are invalid")
        if not np.isin(mask, [0, 1]).all():
            raise HeldoutEvaluationError("held-out waveform sample mask is invalid")
        valid_count = int(mask.sum())
        if valid_count <= 0 or not np.array_equal(mask, np.r_[np.ones(valid_count), np.zeros(mask.size-valid_count)]):
            raise HeldoutEvaluationError("held-out waveform mask must be a contiguous valid prefix")
        reference_wave = target[:valid_count]
        generated = runtime.synthesize(
            example.tokens.phoneme_ids,
            example.tokens.note_ids,
            example.pitch_targets.f0_hz,
            example.pitch_targets.voicing_mask,
            example.pitch_targets.energy,
            example.speaker_reference_log_mel,
        )
        generated = np.asarray(generated, dtype=np.float32)
        if generated.ndim != 1 or generated.size < valid_count:
            raise HeldoutEvaluationError("generated waveform is shorter than the held-out reference")
        generated = generated[:valid_count]
        generated_features = extract_acoustic_features(
            _float_wav_bytes(generated, feature_config.sample_rate), feature_config
        )
        target_features = example.acoustic
        target_frame_count = int(target_features.f0_hz.size)
        generated_frame_count = int(generated_features.f0_hz.size)
        if target_frame_count <= 0 or generated_frame_count != target_frame_count:
            raise HeldoutEvaluationError("generated and reference feature frame counts do not match")
        expected_shapes = (
            (target_features.log_mel.shape, generated_features.log_mel.shape),
            (target_features.voicing_mask.shape, generated_features.voicing_mask.shape),
            (target_features.log_rms.shape, generated_features.log_rms.shape),
        )
        if any(reference_shape != generated_shape for reference_shape, generated_shape in expected_shapes):
            raise HeldoutEvaluationError("generated and reference acoustic feature shapes do not match")
        common_frames = target_frame_count
        reports.append(evaluate_singing_output(
            reference_waveform=reference_wave,
            generated_waveform=generated,
            reference_f0_hz=target_features.f0_hz[:common_frames],
            generated_f0_hz=generated_features.f0_hz[:common_frames],
            reference_voicing=target_features.voicing_mask[:common_frames],
            generated_voicing=generated_features.voicing_mask[:common_frames],
            reference_log_mel=target_features.log_mel[:common_frames],
            generated_log_mel=generated_features.log_mel[:common_frames],
            reference_log_rms=target_features.log_rms[:common_frames],
            generated_log_rms=generated_features.log_rms[:common_frames],
            sample_rate=feature_config.sample_rate,
            hop_length=feature_config.hop_length,
        ))
    summary = summarize_quality_reports(reports)
    summary["evaluation_mode"] = "heldout_test_split_with_ground_truth_phoneme_and_midi_conditioning"
    summary["model_bundle_verified"] = True
    summary["inference_runtime_loaded"] = True
    summary["quality_passed"] = False
    summary["production_approved"] = False
    summary["note"] = (
        "This is an objective held-out test report using reviewed phoneme/MIDI and separate speaker references. "
        "It is not a production approval; human listening review and calibrated thresholds remain required."
    )
    return summary


def evaluate_heldout_bundle(manifest_path, bundle_directory, *, dataset_root=None, device="cpu") -> dict:
    """Verify a local model bundle, load only the held-out test split, and evaluate it."""
    verification = inspect_joint_singing_bundle(bundle_directory)
    if not verification.get("bundle_verified"):
        raise HeldoutEvaluationError("joint model bundle verification failed")
    root = Path(bundle_directory).expanduser().resolve(strict=True)
    bundle_manifest = json.loads((root / MANIFEST_NAME).read_text(encoding="utf-8"))
    feature_config = AcousticModelConfig.model_validate(bundle_manifest["acoustic_feature_config"])
    examples = load_training_examples(
        manifest_path,
        feature_config,
        dataset_root=dataset_root,
        split="test",
        require_speaker_references=True,
        include_waveform_targets=True,
    )
    runtime = SingingInferenceRuntime.from_bundle(root, device=device)
    return evaluate_heldout_examples(examples, runtime, feature_config)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate a verified MEHRAN singing bundle on the local held-out test split."
    )
    parser.add_argument("manifest", help="Local consented dataset JSONL manifest")
    parser.add_argument("bundle", help="Directory containing joint-singing-bundle.json and checkpoint")
    parser.add_argument("--audio-root", help="Root for relative audio paths")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    try:
        result = evaluate_heldout_bundle(
            args.manifest, args.bundle, dataset_root=args.audio_root, device=args.device
        )
    except (HeldoutEvaluationError, ValueError, OSError, RuntimeError) as exc:
        parser.exit(2, f"HELD-OUT EVALUATION NOT COMPLETED: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
