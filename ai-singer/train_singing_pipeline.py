"""Local end-to-end fine-tuning CLI for MEHRAN's Persian singing pipeline.

Requires trained stage-one acoustic and teacher-forced waveform checkpoints.
All audio remains local and must be covered by reviewed consent records.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import random

import numpy as np

from dataset_loader import load_training_examples
from model_architecture import SingingNetworkConfig
from train_model import _acoustic_config, _make_batches
from waveform_decoder import WaveformDecoderConfig
from singing_pipeline import build_singing_pipeline
from training_engine import TrainingConfig, load_checkpoint as load_acoustic_checkpoint
from waveform_training_engine import (
    WaveformTrainingConfig,
    load_checkpoint as load_waveform_checkpoint,
)
from pipeline_training_engine import (
    PipelineTrainingConfig,
    evaluate,
    load_checkpoint,
    save_checkpoint,
    train_one_epoch,
)


def run_training(args) -> dict:
    try:
        import torch
    except ImportError as exc:
        raise RuntimeError("Install training-requirements.txt before running the joint trainer") from exc

    device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is not available")
    if args.resume:
        if args.acoustic_checkpoint or args.waveform_checkpoint:
            raise ValueError("use --resume or the two stage checkpoints, not both")
    elif not args.acoustic_checkpoint or not args.waveform_checkpoint:
        raise ValueError("both --acoustic-checkpoint and --waveform-checkpoint are required")

    for label, path in (
        ("acoustic checkpoint", args.acoustic_checkpoint),
        ("waveform checkpoint", args.waveform_checkpoint),
        ("joint resume checkpoint", args.resume),
    ):
        if path and (not Path(path).is_file() or Path(path).is_symlink()):
            raise ValueError(f"{label} must be an existing regular local file")

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)

    feature_config = _acoustic_config(args.sample_rate, args.hop_length, args.mel_bins)
    acoustic_config = SingingNetworkConfig(mel_bins=args.mel_bins).validate()
    decoder_config = WaveformDecoderConfig(
        mel_bins=args.mel_bins,
        sample_rate=args.sample_rate,
        hop_length=args.hop_length,
    ).validate()
    train_examples = load_training_examples(
        args.manifest, feature_config, dataset_root=args.audio_root, split="train",
        require_speaker_references=True, include_waveform_targets=True,
    )
    validation_examples = load_training_examples(
        args.manifest, feature_config, dataset_root=args.audio_root, split="validation",
        require_speaker_references=True, include_waveform_targets=True,
    )
    if len(train_examples) < 2:
        raise ValueError("at least two reviewed training recordings are required")
    if not validation_examples:
        raise ValueError("a speaker-disjoint validation split is required")

    pipeline = build_singing_pipeline(acoustic_config, decoder_config).to(device)
    if args.resume:
        # Optimizer is created below; weights are loaded first.
        metadata = load_checkpoint(
            args.resume, pipeline,
            expected_acoustic_config=acoustic_config,
            expected_decoder_config=decoder_config,
            map_location=device,
        )
        start_epoch = int(metadata["epoch"]) + 1
        best_validation_loss = float(metadata["metrics"].get("validation_loss", float("inf")))
    else:
        load_acoustic_checkpoint(
            args.acoustic_checkpoint, pipeline.acoustic_model,
            expected_model_config=acoustic_config, map_location=device,
        )
        load_waveform_checkpoint(
            args.waveform_checkpoint, pipeline.waveform_decoder,
            expected_decoder_config=decoder_config, map_location=device,
        )
        start_epoch = 0
        best_validation_loss = float("inf")

    acoustic_training = TrainingConfig(
        learning_rate=args.acoustic_learning_rate, seed=args.seed
    ).validate()
    waveform_training = WaveformTrainingConfig(
        learning_rate=args.waveform_learning_rate,
        stft_sizes=tuple(args.stft_sizes), seed=args.seed,
    ).validate()
    training_config = PipelineTrainingConfig(
        acoustic=acoustic_training,
        waveform=waveform_training,
        acoustic_loss_weight=args.acoustic_loss_weight,
        waveform_loss_weight=args.waveform_loss_weight,
        seed=args.seed,
    ).validate()
    optimizer = torch.optim.AdamW(
        [
            {"params": pipeline.acoustic_model.parameters(), "lr": acoustic_training.learning_rate},
            {"params": pipeline.waveform_decoder.parameters(), "lr": waveform_training.learning_rate},
        ],
        weight_decay=args.weight_decay,
    )
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    latest_path = output_dir / "pipeline-latest.pt"
    best_path = output_dir / "pipeline-best.pt"
    history = []

    for epoch in range(start_epoch, args.epochs):
        train_batches = _make_batches(
            train_examples, feature_config, batch_size=args.batch_size,
            seed=args.seed, epoch=epoch,
        )
        validation_batches = _make_batches(
            validation_examples, feature_config, batch_size=args.batch_size,
            seed=args.seed, epoch=0,
        )
        train_metrics = train_one_epoch(
            pipeline, train_batches, optimizer, training_config, device=device
        )
        validation_metrics = evaluate(
            pipeline, validation_batches, training_config, device=device
        )
        metrics = {
            "training_loss": train_metrics["loss"],
            "validation_loss": validation_metrics["loss"],
            "training_acoustic_loss": train_metrics["acoustic_loss"],
            "validation_acoustic_loss": validation_metrics["acoustic_loss"],
            "training_waveform_loss": train_metrics["waveform_loss"],
            "validation_waveform_loss": validation_metrics["waveform_loss"],
            "training_waveform_l1": train_metrics["waveform_l1"],
            "validation_waveform_l1": validation_metrics["waveform_l1"],
            "training_spectral_convergence": train_metrics["spectral_convergence"],
            "validation_spectral_convergence": validation_metrics["spectral_convergence"],
            "training_log_magnitude": train_metrics["log_magnitude"],
            "validation_log_magnitude": validation_metrics["log_magnitude"],
        }
        save_checkpoint(
            latest_path, pipeline, optimizer, epoch=epoch, metrics=metrics,
            acoustic_config=acoustic_config, decoder_config=decoder_config,
            training_config=training_config,
        )
        if validation_metrics["loss"] < best_validation_loss:
            best_validation_loss = validation_metrics["loss"]
            save_checkpoint(
                best_path, pipeline, optimizer, epoch=epoch, metrics=metrics,
                acoustic_config=acoustic_config, decoder_config=decoder_config,
                training_config=training_config,
            )
        record = {"epoch": epoch + 1, **metrics}
        history.append(record)
        print(json.dumps(record, ensure_ascii=False, sort_keys=True), flush=True)

    if not history and start_epoch >= args.epochs:
        raise ValueError("requested epochs are already complete; increase --epochs to continue")
    return {
        "epochs_completed": len(history),
        "training_recordings": len(train_examples),
        "validation_recordings": len(validation_examples),
        "best_validation_loss": best_validation_loss,
        "best_checkpoint": str(best_path) if best_path.is_file() else None,
        "latest_checkpoint": str(latest_path) if latest_path.is_file() else None,
        "conditioning_mode": "predicted_acoustic_features_end_to_end",
        "audio_generated": False,
        "inference_ready": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Jointly fine-tune MEHRAN's Persian acoustic-to-waveform singing pipeline."
    )
    parser.add_argument("--manifest", required=True, help="Local JSONL manifest with reviewed consented recordings")
    parser.add_argument("--audio-root", help="Root folder for relative WAV paths in the manifest")
    parser.add_argument("--acoustic-checkpoint", help="Trained stage-one acoustic checkpoint")
    parser.add_argument("--waveform-checkpoint", help="Trained teacher-forced waveform decoder checkpoint")
    parser.add_argument("--resume", help="Resume a prior joint pipeline checkpoint instead of loading two stage checkpoints")
    parser.add_argument("--output-dir", default="./checkpoints/mehran-fa-joint")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--sample-rate", type=int, default=48000)
    parser.add_argument("--hop-length", type=int, default=256)
    parser.add_argument("--mel-bins", type=int, default=100)
    parser.add_argument("--acoustic-learning-rate", type=float, default=2e-5)
    parser.add_argument("--waveform-learning-rate", type=float, default=5e-5)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--acoustic-loss-weight", type=float, default=1.0)
    parser.add_argument("--waveform-loss-weight", type=float, default=1.0)
    parser.add_argument("--stft-sizes", type=int, nargs="+", default=[512, 1024, 2048])
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    if args.epochs < 1 or args.batch_size < 1:
        parser.error("--epochs and --batch-size must be positive")
    if not args.stft_sizes or any(value < 16 for value in args.stft_sizes):
        parser.error("--stft-sizes values must be at least 16")
    result = run_training(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
