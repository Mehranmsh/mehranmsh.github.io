"""Guarded local inference runtime for trained MEHRAN Persian singing pipelines.

Loading a checkpoint enables local inference only. Production/API enablement still
requires independent quality approval and an explicit deployment decision.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from model_architecture import SingingNetworkConfig
from waveform_decoder import WaveformDecoderConfig
from singing_pipeline import build_singing_pipeline
from pipeline_training_engine import load_checkpoint
from waveform_output import write_waveform_output
from joint_model_bundle import inspect_joint_singing_bundle, MANIFEST_NAME as JOINT_BUNDLE_MANIFEST
import json

MAX_CHECKPOINT_BYTES = 20 * 1024 * 1024 * 1024


class SingingInferenceRuntime:
    def __init__(self, pipeline, *, device: str, acoustic_config: SingingNetworkConfig,
                 decoder_config: WaveformDecoderConfig, checkpoint_path: str,
                 checkpoint_metadata: dict):
        self.pipeline = pipeline
        self.device = device
        self.acoustic_config = acoustic_config
        self.decoder_config = decoder_config
        self.checkpoint_path = checkpoint_path
        self.checkpoint_metadata = checkpoint_metadata
        self.bundle_verification = None
        self.pipeline.eval()

    @classmethod
    def from_checkpoint(
        cls,
        checkpoint_path: str | Path,
        *,
        acoustic_config: SingingNetworkConfig | None = None,
        decoder_config: WaveformDecoderConfig | None = None,
        device: str = "cpu",
    ) -> "SingingInferenceRuntime":
        try:
            import torch
        except ImportError as exc:
            raise RuntimeError("PyTorch is required; install training-requirements.txt") from exc
        source = Path(checkpoint_path).expanduser()
        if source.is_symlink() or not source.is_file():
            raise ValueError("joint checkpoint must be an existing regular non-symlink file")
        if source.stat().st_size <= 0 or source.stat().st_size > MAX_CHECKPOINT_BYTES:
            raise ValueError("joint checkpoint size is outside the supported range")
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is not available")
        acoustic_cfg = (acoustic_config or SingingNetworkConfig()).validate()
        decoder_cfg = (decoder_config or WaveformDecoderConfig()).validate()
        pipeline = build_singing_pipeline(acoustic_cfg, decoder_cfg).to(device)
        metadata = load_checkpoint(
            source, pipeline,
            expected_acoustic_config=acoustic_cfg,
            expected_decoder_config=decoder_cfg,
            map_location=device,
        )
        return cls(
            pipeline, device=device, acoustic_config=acoustic_cfg,
            decoder_config=decoder_cfg, checkpoint_path=str(source),
            checkpoint_metadata=metadata,
        )


    @classmethod
    def from_bundle(cls, bundle_directory: str | Path, *, device: str = "cpu") -> "SingingInferenceRuntime":
        """Verify a joint bundle manifest and checkpoint hash before loading weights."""
        verification = inspect_joint_singing_bundle(bundle_directory)
        if not verification.get("bundle_verified"):
            raise ValueError(f"joint singing bundle verification failed: {verification.get('reason')}")
        root = Path(bundle_directory).expanduser().resolve(strict=True)
        manifest_path = root / JOINT_BUNDLE_MANIFEST
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        acoustic_config = SingingNetworkConfig(**manifest["acoustic_model_config"]).validate()
        decoder_payload = dict(manifest["waveform_decoder_config"])
        decoder_payload["upsample_factors"] = tuple(decoder_payload["upsample_factors"])
        decoder_payload["residual_dilations"] = tuple(decoder_payload["residual_dilations"])
        decoder_config = WaveformDecoderConfig(**decoder_payload).validate()
        runtime = cls.from_checkpoint(
            verification["checkpoint_path"],
            acoustic_config=acoustic_config,
            decoder_config=decoder_config,
            device=device,
        )
        runtime.bundle_verification = verification
        return runtime

    def status(self) -> dict:
        return {
            "runtime_loaded": True,
            "checkpoint": self.checkpoint_path,
            "checkpoint_epoch": self.checkpoint_metadata.get("epoch"),
            "language": "fa",
            "sample_rate": self.decoder_config.sample_rate,
            "local_inference_available": True,
            "production_approved": False,
            "bundle_verified": bool(self.bundle_verification and self.bundle_verification.get("bundle_verified")),
            "bundle_id": self.bundle_verification.get("bundle_id") if self.bundle_verification else None,
            "reason": "local checkpoint loaded; held-out quality and deployment approval remain separate",
        }

    def synthesize(
        self,
        phoneme_ids,
        note_ids,
        conditioning_f0_hz,
        conditioning_voicing_mask,
        conditioning_energy,
        speaker_reference_log_mel,
        *,
        max_frames: int = 12000,
    ) -> np.ndarray:
        try:
            import torch
        except ImportError as exc:
            raise RuntimeError("PyTorch is required for inference") from exc

        def vector(value, name, dtype):
            array = np.asarray(value, dtype=dtype)
            if array.ndim != 1 or array.size == 0 or not np.isfinite(array).all():
                raise ValueError(f"{name} must be a non-empty finite one-dimensional array")
            return array

        phones = vector(phoneme_ids, "phoneme_ids", np.int64)
        notes = vector(note_ids, "note_ids", np.int64)
        f0 = vector(conditioning_f0_hz, "conditioning_f0_hz", np.float32)
        voice = vector(conditioning_voicing_mask, "conditioning_voicing_mask", np.float32)
        energy = vector(conditioning_energy, "conditioning_energy", np.float32)
        frames = phones.size
        if frames > max_frames or max_frames < 1:
            raise ValueError("requested frame sequence exceeds the configured inference limit")
        if any(array.size != frames for array in (notes, f0, voice, energy)):
            raise ValueError("phoneme, note, pitch, voicing, and energy tracks must have equal lengths")
        if np.any(phones < 0) or np.any(phones >= self.acoustic_config.phoneme_vocab_size):
            raise ValueError("phoneme IDs exceed the trained vocabulary")
        if np.any(notes < 0) or np.any(notes >= self.acoustic_config.note_vocab_size):
            raise ValueError("note IDs exceed the trained MIDI vocabulary")
        if np.any(f0 < 0) or np.any(voice < 0) or np.any(voice > 1):
            raise ValueError("F0 must be non-negative and voicing values must be within [0, 1]")

        reference = np.asarray(speaker_reference_log_mel, dtype=np.float32)
        if (reference.ndim != 2 or reference.shape[0] < 1
                or reference.shape[0] > 60000
                or reference.shape[1] != self.acoustic_config.mel_bins
                or not np.isfinite(reference).all()):
            raise ValueError("speaker reference must be finite (frames, mel_bins) within the supported length")
        if not np.isfinite(energy).all():
            raise ValueError("energy conditioning must contain finite values")

        tensors = [
            torch.as_tensor(phones[None, :], dtype=torch.long, device=self.device),
            torch.as_tensor(notes[None, :], dtype=torch.long, device=self.device),
            torch.as_tensor(f0[None, :], dtype=torch.float32, device=self.device),
            torch.as_tensor(voice[None, :], dtype=torch.float32, device=self.device),
            torch.as_tensor(energy[None, :], dtype=torch.float32, device=self.device),
            torch.ones((1, frames), dtype=torch.bool, device=self.device),
            torch.as_tensor(reference[None, :, :], dtype=torch.float32, device=self.device),
            torch.ones((1, reference.shape[0]), dtype=torch.bool, device=self.device),
        ]
        self.pipeline.eval()
        with torch.inference_mode():
            result = self.pipeline(*tensors)
        samples = result["waveform"][0, :frames * self.decoder_config.hop_length]
        audio = samples.detach().to("cpu", dtype=torch.float32).numpy()
        if audio.size != frames * self.decoder_config.hop_length:
            raise RuntimeError("inference waveform length does not match the frame/hop contract")
        if not np.isfinite(audio).all() or np.any(audio < -1.00001) or np.any(audio > 1.00001):
            raise RuntimeError("inference produced non-finite or out-of-range waveform samples")
        return np.clip(audio, -1.0, 1.0).astype(np.float32, copy=False)

    def synthesize_to_wav(self, *args, output_directory: str | Path, project_id: str,
                          **kwargs) -> dict:
        audio = self.synthesize(*args, **kwargs)
        return write_waveform_output(
            audio,
            output_directory=output_directory,
            project_id=project_id,
            sample_rate=self.decoder_config.sample_rate,
        )
