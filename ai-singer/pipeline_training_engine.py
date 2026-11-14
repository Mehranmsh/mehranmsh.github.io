"""Joint fine-tuning engine for predicted-acoustic-to-waveform singing.

Unlike the decoder pretraining stage, this engine feeds the acoustic network's
predictions into the waveform decoder and optimizes both networks end to end.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import math
import os
from pathlib import Path
import tempfile
from typing import Iterable

import numpy as np

from batch_collator import TrainingBatch
from model_architecture import SingingNetworkConfig
from training_engine import TrainingConfig, _batch_tensors, compute_training_loss
from waveform_decoder import WaveformDecoderConfig
from waveform_losses import waveform_reconstruction_losses
from waveform_training_engine import WaveformTrainingConfig


@dataclass(frozen=True)
class PipelineTrainingConfig:
    acoustic: TrainingConfig = TrainingConfig()
    waveform: WaveformTrainingConfig = WaveformTrainingConfig()
    acoustic_loss_weight: float = 1.0
    waveform_loss_weight: float = 1.0
    seed: int = 2026

    def validate(self) -> "PipelineTrainingConfig":
        self.acoustic.validate()
        self.waveform.validate()
        for name in ("acoustic_loss_weight", "waveform_loss_weight"):
            value = getattr(self, name)
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{name} must be finite and non-negative")
        if self.acoustic_loss_weight + self.waveform_loss_weight <= 0:
            raise ValueError("at least one pipeline loss weight must be positive")
        if isinstance(self.seed, bool) or not isinstance(self.seed, int):
            raise ValueError("seed must be an integer")
        return self


def _torch():
    try:
        import torch
    except ImportError as exc:
        raise RuntimeError("Install ai-singer/training-requirements.txt to train the singing pipeline") from exc
    return torch


def _pipeline_forward(pipeline, tensors):
    return pipeline(
        tensors["phoneme_ids"],
        tensors["note_ids"],
        tensors["conditioning_f0_hz"],
        tensors["conditioning_voicing_mask"],
        tensors["conditioning_energy"],
        tensors["valid_frame_mask"],
        tensors.get("speaker_reference_log_mel"),
        tensors.get("speaker_reference_frame_mask"),
    )


def compute_pipeline_losses(pipeline, batch: TrainingBatch, config: PipelineTrainingConfig, *, device="cpu"):
    torch = _torch()
    config.validate()
    if batch.waveform_target is None or batch.waveform_sample_mask is None:
        raise ValueError("joint pipeline training requires paired waveform targets")
    if batch.speaker_reference_log_mel is None or batch.speaker_reference_frame_mask is None:
        raise ValueError("joint pipeline training requires separate speaker references")
    if batch.sample_rate != pipeline.sample_rate or batch.hop_length != pipeline.hop_length:
        raise ValueError("batch audio geometry does not match the singing pipeline")

    tensors = _batch_tensors(batch, device)
    output = _pipeline_forward(pipeline, tensors)
    acoustic_total, acoustic_parts = compute_training_loss(
        output["acoustic"], batch, config.acoustic
    )
    waveform_target = torch.as_tensor(
        np.asarray(batch.waveform_target), dtype=torch.float32, device=device
    )
    waveform_mask = torch.as_tensor(
        np.asarray(batch.waveform_sample_mask), dtype=torch.float32, device=device
    )
    if waveform_target.shape != output["waveform"].shape:
        raise ValueError("predicted waveform shape does not match padded waveform targets")
    waveform_parts = waveform_reconstruction_losses(
        output["waveform"],
        waveform_target,
        waveform_mask,
        stft_sizes=config.waveform.stft_sizes,
        waveform_l1_weight=config.waveform.waveform_l1_weight,
        spectral_convergence_weight=config.waveform.spectral_convergence_weight,
        log_magnitude_weight=config.waveform.log_magnitude_weight,
    )
    total = (
        config.acoustic_loss_weight * acoustic_total
        + config.waveform_loss_weight * waveform_parts["total"]
    )
    if not torch.isfinite(total):
        raise FloatingPointError("non-finite joint singing pipeline loss")
    return total, {
        "acoustic_loss": acoustic_total,
        "waveform_loss": waveform_parts["total"],
        "mel": acoustic_parts["mel"],
        "f0": acoustic_parts["f0"],
        "voicing": acoustic_parts["voicing"],
        "energy": acoustic_parts["energy"],
        "waveform_l1": waveform_parts["waveform_l1"],
        "spectral_convergence": waveform_parts["spectral_convergence"],
        "log_magnitude": waveform_parts["log_magnitude"],
    }


def _run_epoch(pipeline, batches: Iterable[TrainingBatch], optimizer, config, *, device, training):
    torch = _torch()
    config.validate()
    pipeline.train(training)
    names = (
        "loss", "acoustic_loss", "waveform_loss", "mel", "f0", "voicing",
        "energy", "waveform_l1", "spectral_convergence", "log_magnitude",
    )
    totals = {name: 0.0 for name in names}
    count = 0
    context = torch.enable_grad() if training else torch.no_grad()
    with context:
        for batch in batches:
            if training:
                optimizer.zero_grad(set_to_none=True)
            total, parts = compute_pipeline_losses(pipeline, batch, config, device=device)
            if training:
                total.backward()
                torch.nn.utils.clip_grad_norm_(
                    pipeline.acoustic_model.parameters(),
                    config.acoustic.gradient_clip_norm,
                )
                torch.nn.utils.clip_grad_norm_(
                    pipeline.waveform_decoder.parameters(),
                    config.waveform.gradient_clip_norm,
                )
                optimizer.step()
            totals["loss"] += float(total.detach().cpu())
            for name, value in parts.items():
                totals[name] += float(value.detach().cpu())
            count += 1
    if count == 0:
        raise ValueError("joint pipeline training requires at least one batch")
    return {name: value / count for name, value in totals.items()} | {"batches": count}


def train_one_epoch(pipeline, batches, optimizer, config, *, device="cpu"):
    return _run_epoch(pipeline, batches, optimizer, config, device=device, training=True)


def evaluate(pipeline, batches, config, *, device="cpu"):
    return _run_epoch(pipeline, batches, None, config, device=device, training=False)


def save_checkpoint(path, pipeline, optimizer, *, epoch: int, metrics: dict,
                    acoustic_config: SingingNetworkConfig,
                    decoder_config: WaveformDecoderConfig,
                    training_config: PipelineTrainingConfig):
    torch = _torch()
    acoustic_config.validate()
    decoder_config.validate()
    training_config.validate()
    if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch < 0:
        raise ValueError("epoch must be a non-negative integer")
    if not isinstance(metrics, dict) or any(
        not isinstance(k, str) or not isinstance(v, (int, float))
        or not math.isfinite(float(v)) for k, v in metrics.items()
    ):
        raise ValueError("metrics must be a mapping of finite numeric values")
    destination = Path(path)
    if destination.suffix.lower() not in {".pt", ".pth"}:
        raise ValueError("checkpoint path must end in .pt or .pth")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        raise ValueError("checkpoint destination cannot be a symlink")
    payload = {
        "schema_version": "mehran.svs.joint-pipeline-checkpoint.v1",
        "epoch": epoch,
        "metrics": {k: float(v) for k, v in metrics.items()},
        "acoustic_config": asdict(acoustic_config),
        "decoder_config": asdict(decoder_config),
        "training_config": {
            "acoustic": asdict(training_config.acoustic),
            "waveform": asdict(training_config.waveform),
            "acoustic_loss_weight": training_config.acoustic_loss_weight,
            "waveform_loss_weight": training_config.waveform_loss_weight,
            "seed": training_config.seed,
        },
        "pipeline_state_dict": pipeline.state_dict(),
        "optimizer_state_dict": optimizer.state_dict(),
    }
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=".mehran-joint-", suffix=".tmp",
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


def load_checkpoint(path, pipeline, optimizer=None, *, expected_acoustic_config=None,
                    expected_decoder_config=None, map_location="cpu"):
    torch = _torch()
    source = Path(path)
    if not source.is_file() or source.is_symlink():
        raise ValueError("joint checkpoint must be an existing regular file")
    payload = torch.load(source, map_location=map_location, weights_only=True)
    if not isinstance(payload, dict) or payload.get("schema_version") != "mehran.svs.joint-pipeline-checkpoint.v1":
        raise ValueError("unsupported or invalid joint pipeline checkpoint")
    if expected_acoustic_config is not None and payload.get("acoustic_config") != asdict(expected_acoustic_config.validate()):
        raise ValueError("joint checkpoint acoustic configuration mismatch")
    if expected_decoder_config is not None and payload.get("decoder_config") != asdict(expected_decoder_config.validate()):
        raise ValueError("joint checkpoint waveform decoder configuration mismatch")
    state = payload.get("pipeline_state_dict")
    if not isinstance(state, dict):
        raise ValueError("joint checkpoint pipeline weights are missing")
    pipeline.load_state_dict(state, strict=True)
    if optimizer is not None:
        optimizer_state = payload.get("optimizer_state_dict")
        if not isinstance(optimizer_state, dict):
            raise ValueError("joint checkpoint optimizer state is missing")
        optimizer.load_state_dict(optimizer_state)
    return {"epoch": payload["epoch"], "metrics": payload["metrics"]}
