"""Local CLI for training the first MEHRAN Persian SVS acoustic model.

Requires a reviewed, consented JSONL manifest and local PCM WAV files.
It never uploads data and never generates singing audio.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import random

import numpy as np

from batch_collator import collate_training_examples
from batch_sampler import make_training_batches
from dataset_loader import load_training_examples
from model_architecture import SingingNetworkConfig, build_singing_model
from phoneme_inventory import INVENTORY_VERSION
from model_config import validate_acoustic_model_config
from training_engine import (
    TrainingConfig,
    evaluate,
    load_checkpoint,
    save_checkpoint,
    train_one_epoch,
)


def _acoustic_config(sample_rate: int, hop_length: int, mel_bins: int):
    n_fft = 2048
    return validate_acoustic_model_config({
        "schema_version": "mehran.svs.acoustic-config.v1",
        "config_id": f"mehran-fa-{sample_rate}-{hop_length}-{mel_bins}-v1",
        "language": "fa",
        "phoneme_inventory_version": INVENTORY_VERSION,
        "sample_rate": sample_rate,
        "n_fft": n_fft,
        "win_length": n_fft,
        "hop_length": hop_length,
        "mel_bins": mel_bins,
        "f_min_hz": 40.0,
        "f_max_hz": min(16000.0, sample_rate / 2 - 1),
        "mel_scale": "slaney",
        "mel_normalization": "slaney",
        "log_floor": 1e-5,
        "frame_alignment": "centered",
        "note_pitch_encoding": "midi_0_127",
        "pitch_track_encoding": "continuous_hz_plus_voicing_mask",
        "energy_track_encoding": "log_rms",
        "target_features": ["log_mel", "f0_hz", "voicing_mask", "log_rms"],
    })


def _make_batches(examples, acoustic_config, *, batch_size: int, seed: int, epoch: int):
    indices = make_training_batches(
        examples, batch_size=batch_size, seed=seed, epoch=epoch,
        bucket_multiplier=20, drop_last=False,
    )
    return [
        collate_training_examples([examples[index] for index in group], acoustic_config)
        for group in indices
    ]


def run_training(args) -> dict:
    try:
        import torch
    except ImportError as exc:
        raise RuntimeError("Install training-requirements.txt before running the trainer") from exc

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)

    device = args.device
    if device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is not available")

    acoustic_config = _acoustic_config(args.sample_rate, args.hop_length, args.mel_bins)
    train_examples = load_training_examples(
        args.manifest, acoustic_config, dataset_root=args.audio_root, split="train",
        require_speaker_references=True,
    )
    validation_examples = load_training_examples(
        args.manifest, acoustic_config, dataset_root=args.audio_root, split="validation",
        require_speaker_references=True,
    )
    if len(train_examples) < 2:
        raise ValueError("at least two reviewed training recordings are required")
    if not validation_examples:
        raise ValueError("a speaker-disjoint validation split is required")

    network_config = SingingNetworkConfig(mel_bins=args.mel_bins).validate()
    training_config = TrainingConfig(seed=args.seed).validate()
    model = build_singing_model(network_config).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=training_config.learning_rate,
        weight_decay=training_config.weight_decay,
    )

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    latest_path = output_dir / "latest.pt"
    best_path = output_dir / "best.pt"
    start_epoch = 0
    best_validation_loss = float("inf")

    if args.resume:
        metadata = load_checkpoint(
            args.resume, model, optimizer,
            expected_model_config=network_config, map_location=device,
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
            model, train_batches, optimizer, training_config, device=device
        )
        validation_metrics = evaluate(
            model, validation_batches, training_config, device=device
        )
        metrics = {
            "training_loss": train_metrics["loss"],
            "validation_loss": validation_metrics["loss"],
            "training_mel_loss": train_metrics["mel"],
            "validation_mel_loss": validation_metrics["mel"],
            "training_f0_loss": train_metrics["f0"],
            "validation_f0_loss": validation_metrics["f0"],
            "training_voicing_loss": train_metrics["voicing"],
            "validation_voicing_loss": validation_metrics["voicing"],
            "training_energy_loss": train_metrics["energy"],
            "validation_energy_loss": validation_metrics["energy"],
        }
        save_checkpoint(
            latest_path, model, optimizer, epoch=epoch, metrics=metrics,
            model_config=network_config, training_config=training_config,
        )
        if validation_metrics["loss"] < best_validation_loss:
            best_validation_loss = validation_metrics["loss"]
            save_checkpoint(
                best_path, model, optimizer, epoch=epoch, metrics=metrics,
                model_config=network_config, training_config=training_config,
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
        "audio_generated": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Train MEHRAN's local Persian SVS acoustic model.")
    parser.add_argument("--manifest", required=True, help="Local JSONL manifest with reviewed consented records")
    parser.add_argument("--audio-root", help="Root folder for relative WAV paths in the manifest")
    parser.add_argument("--output-dir", default="./checkpoints/mehran-fa-svs")
    parser.add_argument("--resume", help="Optional trusted local MEHRAN checkpoint")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--sample-rate", type=int, default=48000)
    parser.add_argument("--hop-length", type=int, default=256)
    parser.add_argument("--mel-bins", type=int, default=100)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    if args.epochs < 1 or args.batch_size < 1:
        parser.error("--epochs and --batch-size must be positive")
    result = run_training(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
