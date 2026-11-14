"""Training loop and safe checkpoints for the MEHRAN neural waveform decoder.

Decoder training is teacher-forced on reviewed ground-truth acoustic features.
It does not yet close the predicted-feature distribution gap.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import math
import os
from pathlib import Path
import tempfile
from typing import Iterable, Sequence

import numpy as np

from waveform_losses import waveform_reconstruction_losses


@dataclass(frozen=True)
class WaveformTrainingConfig:
    learning_rate: float = 1e-4
    weight_decay: float = 1e-4
    gradient_clip_norm: float = 1.0
    stft_sizes: tuple[int, ...] = (512, 1024, 2048)
    waveform_l1_weight: float = 1.0
    spectral_convergence_weight: float = 1.0
    log_magnitude_weight: float = 1.0
    seed: int = 2026

    def validate(self) -> "WaveformTrainingConfig":
        if not math.isfinite(self.learning_rate) or self.learning_rate <= 0:
            raise ValueError("learning_rate must be finite and positive")
        if not math.isfinite(self.weight_decay) or self.weight_decay < 0:
            raise ValueError("weight_decay must be finite and non-negative")
        if not math.isfinite(self.gradient_clip_norm) or self.gradient_clip_norm <= 0:
            raise ValueError("gradient_clip_norm must be finite and positive")
        if not self.stft_sizes or any(
            isinstance(value, bool) or not isinstance(value, int) or value < 16
            for value in self.stft_sizes
        ):
            raise ValueError("stft_sizes must contain integers >=16")
        for name in ("waveform_l1_weight", "spectral_convergence_weight", "log_magnitude_weight"):
            value = getattr(self, name)
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{name} must be finite and non-negative")
        if self.waveform_l1_weight + self.spectral_convergence_weight + self.log_magnitude_weight <= 0:
            raise ValueError("at least one waveform loss weight must be positive")
        if isinstance(self.seed, bool) or not isinstance(self.seed, int):
            raise ValueError("seed must be an integer")
        return self


def _torch():
    try:
        import torch
    except ImportError as exc:
        raise RuntimeError("Install ai-singer/training-requirements.txt to use waveform training") from exc
    return torch


def _tensors(batch, device):
    torch = _torch()
    required = (
        "target_log_mel", "target_f0_hz", "target_voicing_mask", "target_log_rms",
        "speaker_reference_log_mel", "speaker_reference_frame_mask",
        "waveform_target", "waveform_sample_mask",
    )
    if any(getattr(batch, key, None) is None for key in required):
        raise ValueError("waveform training requires paired targets and separate speaker references")
    if batch.sample_rate <= 0 or batch.hop_length <= 0:
        raise ValueError("waveform batch sample rate and hop length must be positive")
    def tensor(value, dtype):
        return torch.as_tensor(np.asarray(value), dtype=dtype, device=device)
    result = {
        "log_mel": tensor(batch.target_log_mel, torch.float32),
        "f0_hz": tensor(batch.target_f0_hz, torch.float32),
        "voicing": tensor(batch.target_voicing_mask, torch.float32),
        "log_rms": tensor(batch.target_log_rms, torch.float32),
        "speaker_reference_log_mel": tensor(batch.speaker_reference_log_mel, torch.float32),
        "speaker_reference_frame_mask": tensor(batch.speaker_reference_frame_mask, torch.bool),
        "waveform_target": tensor(batch.waveform_target, torch.float32),
        "waveform_sample_mask": tensor(batch.waveform_sample_mask, torch.float32),
    }
    expected_samples = result["log_mel"].shape[1] * batch.hop_length
    if result["waveform_target"].shape[1] != expected_samples:
        raise ValueError("waveform target length must equal acoustic frames times hop_length")
    return result


def _step(decoder, batch, config: WaveformTrainingConfig, device):
    tensors = _tensors(batch, device)
    prediction = decoder(
        tensors["log_mel"],
        tensors["f0_hz"],
        tensors["voicing"],
        tensors["log_rms"],
        tensors["speaker_reference_log_mel"],
        tensors["speaker_reference_frame_mask"],
    )
    losses = waveform_reconstruction_losses(
        prediction,
        tensors["waveform_target"],
        tensors["waveform_sample_mask"],
        stft_sizes=config.stft_sizes,
        waveform_l1_weight=config.waveform_l1_weight,
        spectral_convergence_weight=config.spectral_convergence_weight,
        log_magnitude_weight=config.log_magnitude_weight,
    )
    return losses


def train_one_epoch(decoder, batches: Iterable, optimizer, config: WaveformTrainingConfig, *, device="cpu"):
    torch = _torch()
    config.validate()
    decoder.train()
    totals = {"loss": 0.0, "waveform_l1": 0.0, "spectral_convergence": 0.0, "log_magnitude": 0.0}
    count = 0
    for batch in batches:
        optimizer.zero_grad(set_to_none=True)
        losses = _step(decoder, batch, config, device)
        loss = losses["total"]
        if not torch.isfinite(loss):
            raise FloatingPointError("non-finite waveform training loss")
        loss.backward()
        torch.nn.utils.clip_grad_norm_(decoder.parameters(), config.gradient_clip_norm)
        optimizer.step()
        for key, value in (
            ("loss", losses["total"]),
            ("waveform_l1", losses["waveform_l1"]),
            ("spectral_convergence", losses["spectral_convergence"]),
            ("log_magnitude", losses["log_magnitude"]),
        ):
            totals[key] += float(value.detach().cpu())
        count += 1
    if count == 0:
        raise ValueError("waveform training requires at least one batch")
    return {key: value / count for key, value in totals.items()} | {"batches": count}


def evaluate(decoder, batches: Iterable, config: WaveformTrainingConfig, *, device="cpu"):
    torch = _torch()
    config.validate()
    decoder.eval()
    totals = {"loss": 0.0, "waveform_l1": 0.0, "spectral_convergence": 0.0, "log_magnitude": 0.0}
    count = 0
    with torch.no_grad():
        for batch in batches:
            losses = _step(decoder, batch, config, device)
            if not torch.isfinite(losses["total"]):
                raise FloatingPointError("non-finite waveform validation loss")
            for key, value in (
                ("loss", losses["total"]),
                ("waveform_l1", losses["waveform_l1"]),
                ("spectral_convergence", losses["spectral_convergence"]),
                ("log_magnitude", losses["log_magnitude"]),
            ):
                totals[key] += float(value.cpu())
            count += 1
    if count == 0:
        raise ValueError("waveform validation requires at least one batch")
    return {key: value / count for key, value in totals.items()} | {"batches": count}


def save_checkpoint(path, decoder, optimizer, *, epoch: int, metrics: dict,
                    decoder_config, training_config: WaveformTrainingConfig):
    torch = _torch()
    training_config.validate()
    decoder_config.validate()
    if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch < 0:
        raise ValueError("epoch must be a non-negative integer")
    if not isinstance(metrics, dict) or any(
        not isinstance(key, str) or not isinstance(value, (int, float))
        or not math.isfinite(float(value)) for key, value in metrics.items()
    ):
        raise ValueError("metrics must be a mapping of finite numeric values")
    destination = Path(path)
    if destination.suffix.lower() not in {".pt", ".pth"}:
        raise ValueError("checkpoint path must end in .pt or .pth")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        raise ValueError("checkpoint destination cannot be a symlink")
    payload = {
        "schema_version": "mehran.svs.waveform-checkpoint.v1",
        "epoch": epoch,
        "metrics": {key: float(value) for key, value in metrics.items()},
        "decoder_config": asdict(decoder_config),
        "training_config": asdict(training_config),
        "decoder_state_dict": decoder.state_dict(),
        "optimizer_state_dict": optimizer.state_dict(),
    }
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=".mehran-waveform-", suffix=".tmp",
            dir=destination.parent, delete=False
        ) as handle:
            temp_name = handle.name
            torch.save(payload, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, destination)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)
    return destination


def load_checkpoint(path, decoder, optimizer=None, *, expected_decoder_config=None, map_location="cpu"):
    torch = _torch()
    source = Path(path)
    if not source.is_file() or source.is_symlink():
        raise ValueError("checkpoint must be an existing regular file")
    payload = torch.load(source, map_location=map_location, weights_only=True)
    if not isinstance(payload, dict) or payload.get("schema_version") != "mehran.svs.waveform-checkpoint.v1":
        raise ValueError("unsupported or invalid MEHRAN waveform checkpoint")
    if expected_decoder_config is not None:
        expected = asdict(expected_decoder_config.validate())
        if payload.get("decoder_config") != expected:
            raise ValueError("checkpoint decoder configuration does not match requested decoder")
    if not isinstance(payload.get("decoder_state_dict"), dict):
        raise ValueError("checkpoint decoder state is missing")
    decoder.load_state_dict(payload["decoder_state_dict"], strict=True)
    if optimizer is not None:
        if not isinstance(payload.get("optimizer_state_dict"), dict):
            raise ValueError("checkpoint optimizer state is missing")
        optimizer.load_state_dict(payload["optimizer_state_dict"])
    return {
        "epoch": payload["epoch"],
        "metrics": payload["metrics"],
        "decoder_config": payload["decoder_config"],
        "training_config": payload["training_config"],
    }
