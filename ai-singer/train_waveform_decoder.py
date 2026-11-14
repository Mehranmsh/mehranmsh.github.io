"""Local teacher-forced training CLI for MEHRAN's neural waveform decoder.

Uses only reviewed, consented local WAV files. No audio is uploaded or rendered.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import random

import numpy as np

from dataset_loader import load_training_examples
from train_model import _acoustic_config, _make_batches
from waveform_decoder import WaveformDecoderConfig, build_waveform_decoder
from waveform_training_engine import (
    WaveformTrainingConfig,
    evaluate,
    load_checkpoint,
    save_checkpoint,
    train_one_epoch,
)


def run_training(args) -> dict:
    try:
        import torch
    except ImportError as exc:
        raise RuntimeError("Install training-requirements.txt before running the decoder trainer") from exc

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    device = args.device
    if device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is not available")

    acoustic_config = _acoustic_config(48000, 256, 100)
    train_examples = load_training_examples(
        args.manifest, acoustic_config, dataset_root=args.audio_root, split="train",
        require_speaker_references=True, include_waveform_targets=True,
    )
    validation_examples = load_training_examples(
        args.manifest, acoustic_config, dataset_root=args.audio_root, split="validation",
        require_speaker_references=True, include_waveform_targets=True,
    )
    if len(train_examples) < 2:
        raise ValueError("at least two reviewed training recordings are required")
    if not validation_examples:
        raise ValueError("a speaker-disjoint validation split is required")

    decoder_config = WaveformDecoderConfig(
        mel_bins=acoustic_config.mel_bins,
        sample_rate=acoustic_config.sample_rate,
        hop_length=acoustic_config.hop_length,
    ).validate()
    training_config = WaveformTrainingConfig(
        stft_sizes=tuple(args.stft_sizes), seed=args.seed,
    ).validate()
    decoder = build_waveform_decoder(decoder_config).to(device)
    optimizer = torch.optim.AdamW(
        decoder.parameters(),
        lr=training_config.learning_rate,
        weight_decay=training_config.weight_decay,
    )

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    latest_path = output_dir / "waveform-latest.pt"
    best_path = output_dir / "waveform-best.pt"
    start_epoch = 0
    best_validation_loss = float("inf")
    if args.resume:
        metadata = load_checkpoint(
            args.resume, decoder, optimizer,
            expected_decoder_config=decoder_config, map_location=device,
        )
        start_epoch = int(metadata["epoch"]) + 1
        best_validation_loss = float(metadata["metrics"].get("validation_loss", float("inf")))

    history = []
    for epoch in range(start_epoch, args.epochs):
        train_batches = _make_batches(
            train_examples, acoustic_config, batch_size=args.batch_size,
            seed=args.seed, epoch=epoch,
        )
        validation_batches = _make_batches(
            validation_examples, acoustic_config, batch_size=args.batch_size,
            seed=args.seed, epoch=0,
        )
        train_metrics = train_one_epoch(
            decoder, train_batches, optimizer, training_config, device=device
        )
        validation_metrics = evaluate(
            decoder, validation_batches, training_config, device=device
        )
        metrics = {
            "training_loss": train_metrics["loss"],
            "validation_loss": validation_metrics["loss"],
            "training_waveform_l1": train_metrics["waveform_l1"],
            "validation_waveform_l1": validation_metrics["waveform_l1"],
            "training_spectral_convergence": train_metrics["spectral_convergence"],
            "validation_spectral_convergence": validation_metrics["spectral_convergence"],
            "training_log_magnitude": train_metrics["log_magnitude"],
            "validation_log_magnitude": validation_metrics["log_magnitude"],
        }
        save_checkpoint(
            latest_path, decoder, optimizer, epoch=epoch, metrics=metrics,
            decoder_config=decoder_config, training_config=training_config,
        )
        if validation_metrics["loss"] < best_validation_loss:
            best_validation_loss = validation_metrics["loss"]
            save_checkpoint(
                best_path, decoder, optimizer, epoch=epoch, metrics=metrics,
                decoder_config=decoder_config, training_config=training_config,
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
        "conditioning_mode": "teacher_forced_ground_truth_acoustics",
        "audio_generated": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Train MEHRAN's local Persian waveform decoder on reviewed paired recordings."
    )
    parser.add_argument("--manifest", required=True, help="Local JSONL manifest with reviewed consented records")
    parser.add_argument("--audio-root", help="Root folder for relative WAV paths in the manifest")
    parser.add_argument("--output-dir", default="./checkpoints/mehran-fa-waveform")
    parser.add_argument("--resume", help="Optional trusted MEHRAN waveform checkpoint")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--seed", type=int, default=2026)
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
