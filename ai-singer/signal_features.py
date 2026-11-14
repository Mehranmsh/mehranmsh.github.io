"""Deterministic WAV feature extraction for the MEHRAN Persian SVS training pipeline.

This module prepares acoustic targets only. It is not a singing synthesizer.
"""
from __future__ import annotations

import io
import wave
from dataclasses import dataclass

import numpy as np

from model_config import AcousticModelConfig


@dataclass(frozen=True)
class AcousticFeatures:
    log_mel: np.ndarray
    f0_hz: np.ndarray
    voicing_mask: np.ndarray
    log_rms: np.ndarray
    sample_rate: int
    hop_length: int


def _decode_pcm(raw: bytes, sample_width: int) -> np.ndarray:
    if sample_width == 1:
        # WAV 8-bit PCM is unsigned.
        values = np.frombuffer(raw, dtype=np.uint8).astype(np.float32)
        return (values - 128.0) / 128.0
    if sample_width == 2:
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if sample_width == 3:
        data = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        values = (data[:, 0].astype(np.int32)
                  | (data[:, 1].astype(np.int32) << 8)
                  | (data[:, 2].astype(np.int32) << 16))
        values = np.where(values & 0x800000, values - 0x1000000, values)
        return values.astype(np.float32) / 8388608.0
    if sample_width == 4:
        return np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    raise ValueError("WAV PCM sample width must be 8, 16, 24, or 32 bit")


def read_mono_pcm_wav(source: bytes, expected_sample_rate: int) -> np.ndarray:
    """Read a bounded, uncompressed mono PCM WAV byte payload."""
    try:
        with wave.open(io.BytesIO(source), "rb") as wav:
            if wav.getcomptype() != "NONE":
                raise ValueError("compressed WAV is not supported")
            if wav.getnchannels() != 1:
                raise ValueError("training feature extraction requires mono WAV")
            if wav.getframerate() != expected_sample_rate:
                raise ValueError("WAV sample rate does not match model config")
            frames = wav.getnframes()
            if frames <= 0 or frames > expected_sample_rate * 600:
                raise ValueError("WAV duration must be between 0 and 600 seconds")
            samples = _decode_pcm(wav.readframes(frames), wav.getsampwidth())
    except (wave.Error, EOFError) as exc:
        raise ValueError("invalid PCM WAV payload") from exc
    if samples.size == 0 or not np.all(np.isfinite(samples)):
        raise ValueError("WAV contains no finite audio samples")
    return np.clip(samples, -1.0, 1.0)


def _hz_to_mel_slaney(hz: np.ndarray) -> np.ndarray:
    f_sp = 200.0 / 3
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    linear = hz / f_sp
    logarithmic = min_log_mel + np.log(np.maximum(hz, min_log_hz) / min_log_hz) / logstep
    return np.where(hz >= min_log_hz, logarithmic, linear)


def _mel_to_hz_slaney(mel: np.ndarray) -> np.ndarray:
    f_sp = 200.0 / 3
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    linear = mel * f_sp
    logarithmic = min_log_hz * np.exp(logstep * (mel - min_log_mel))
    return np.where(mel >= min_log_mel, logarithmic, linear)


def _mel_filterbank(config: AcousticModelConfig) -> np.ndarray:
    mel_edges = np.linspace(
        _hz_to_mel_slaney(np.array([config.f_min_hz]))[0],
        _hz_to_mel_slaney(np.array([config.f_max_hz]))[0],
        config.mel_bins + 2,
    )
    hz_edges = _mel_to_hz_slaney(mel_edges)
    fft_freqs = np.fft.rfftfreq(config.n_fft, 1.0 / config.sample_rate)
    filters = np.zeros((config.mel_bins, fft_freqs.size), dtype=np.float32)
    for index in range(config.mel_bins):
        left, center, right = hz_edges[index:index + 3]
        filters[index] = np.maximum(
            0.0,
            np.minimum((fft_freqs - left) / max(center - left, 1e-12),
                       (right - fft_freqs) / max(right - center, 1e-12)),
        )
        # Slaney area normalization.
        filters[index] *= 2.0 / max(right - left, 1e-12)
    return filters


def _frames(samples: np.ndarray, frame_length: int, hop_length: int) -> np.ndarray:
    half = frame_length // 2
    pad_mode = "reflect" if samples.size > half else "edge"
    padded = np.pad(samples, (half, half), mode=pad_mode)
    count = 1 + (padded.size - frame_length) // hop_length
    shape = (count, frame_length)
    strides = (padded.strides[0] * hop_length, padded.strides[0])
    return np.lib.stride_tricks.as_strided(padded, shape=shape, strides=strides).copy()


def _estimate_f0(frames: np.ndarray, sample_rate: int) -> tuple[np.ndarray, np.ndarray]:
    # FFT autocorrelation, with a conservative periodicity confidence gate.
    centered = frames - np.mean(frames, axis=1, keepdims=True)
    windowed = centered * np.hanning(frames.shape[1]).astype(np.float32)
    n_fft = 1 << (2 * frames.shape[1] - 1).bit_length()
    spectrum = np.fft.rfft(windowed, n=n_fft, axis=1)
    autocorr = np.fft.irfft(spectrum * np.conj(spectrum), n=n_fft, axis=1)
    min_lag = max(1, int(sample_rate / 500.0))
    max_lag = min(frames.shape[1] - 2, int(sample_rate / 50.0))
    if max_lag <= min_lag:
        raise ValueError("analysis frame is too short for the supported F0 range")
    region = autocorr[:, min_lag:max_lag + 1]
    offsets = np.argmax(region, axis=1) + min_lag
    peak = autocorr[np.arange(frames.shape[0]), offsets]
    base = np.maximum(autocorr[:, 0], 1e-12)
    confidence = peak / base
    voiced = (confidence >= 0.30) & (np.sqrt(np.mean(frames * frames, axis=1)) >= 1e-4)
    f0 = np.where(voiced, sample_rate / np.maximum(offsets, 1), 0.0).astype(np.float32)
    return f0, voiced.astype(np.float32)


def extract_acoustic_features(wav_bytes: bytes, config: AcousticModelConfig) -> AcousticFeatures:
    """Extract log-Mel, F0/voicing, and log-RMS tracks from mono PCM WAV."""
    samples = read_mono_pcm_wav(wav_bytes, config.sample_rate)
    frames = _frames(samples, config.win_length, config.hop_length)
    window = np.hanning(config.win_length).astype(np.float32)
    spectrum = np.fft.rfft(frames * window[None, :], n=config.n_fft, axis=1)
    power = (np.abs(spectrum) ** 2).astype(np.float32) / max(float(np.sum(window ** 2)), 1e-12)
    mel = power @ _mel_filterbank(config).T
    log_mel = np.log(np.maximum(mel, config.log_floor)).astype(np.float32)
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    log_rms = np.log(np.maximum(rms, config.log_floor)).astype(np.float32)
    f0, voiced = _estimate_f0(frames, config.sample_rate)
    expected = log_mel.shape[0]
    if not (f0.size == voiced.size == log_rms.size == expected):
        raise RuntimeError("feature tracks are not frame-aligned")
    return AcousticFeatures(
        log_mel=log_mel,
        f0_hz=f0,
        voicing_mask=voiced,
        log_rms=log_rms,
        sample_rate=config.sample_rate,
        hop_length=config.hop_length,
    )
