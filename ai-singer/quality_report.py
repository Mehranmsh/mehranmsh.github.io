"""Privacy-safe aggregation for held-out singing quality reports.

Accepts only metric dictionaries. Never stores audio, paths, speaker IDs, or transcripts.
"""
from __future__ import annotations

import math

SCHEMA_VERSION = "mehran.svs.quality-report.v1"
REPORT_VERSION = "mehran.svs.quality-summary.v1"
METRICS = (
    "voiced_frame_precision",
    "voiced_frame_recall",
    "voiced_frame_f1",
    "f0_cents_rmse",
    "f0_voiced_frame_coverage",
    "log_mel_mae",
    "log_rms_mae",
    "waveform_snr_db",
    "multi_resolution_spectral_convergence",
    "multi_resolution_log_magnitude_mae",
    "peak_amplitude",
    "clipped_sample_fraction",
)


class QualitySummaryError(ValueError):
    """Invalid or incompatible quality reports."""


def _finite_number(value, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise QualitySummaryError(f"{field} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise QualitySummaryError(f"{field} must be a finite number")
    return result


def _percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def summarize_quality_reports(reports) -> dict:
    """Summarize per-recording reports without retaining recording identifiers."""
    if not isinstance(reports, (list, tuple)) or not reports:
        raise QualitySummaryError("reports must be a non-empty list or tuple")

    normalized = []
    contract = None
    total_duration = 0.0
    total_frames = 0

    for index, report in enumerate(reports):
        if not isinstance(report, dict):
            raise QualitySummaryError(f"report {index} must be a dictionary")
        if report.get("schema_version") != SCHEMA_VERSION:
            raise QualitySummaryError(f"report {index} has an unsupported schema")
        sample_rate = report.get("sample_rate")
        hop_length = report.get("hop_length")
        if (isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or sample_rate <= 0
                or isinstance(hop_length, bool) or not isinstance(hop_length, int) or hop_length <= 0):
            raise QualitySummaryError(f"report {index} has an invalid audio contract")
        current_contract = (sample_rate, hop_length)
        if contract is None:
            contract = current_contract
        elif contract != current_contract:
            raise QualitySummaryError("reports must share sample_rate and hop_length")

        frames = report.get("frames_evaluated")
        if isinstance(frames, bool) or not isinstance(frames, int) or frames <= 0:
            raise QualitySummaryError(f"report {index} has invalid frames_evaluated")
        duration = _finite_number(report.get("duration_seconds"), "duration_seconds")
        if duration <= 0:
            raise QualitySummaryError(f"report {index} duration_seconds must be positive")

        values = {}
        for metric in METRICS:
            value = report.get(metric)
            values[metric] = None if value is None else _finite_number(value, metric)
        normalized.append((frames, values))
        total_frames += frames
        total_duration += duration

    metric_summary = {}
    for metric in METRICS:
        pairs = [(frames, values[metric]) for frames, values in normalized
                 if values[metric] is not None]
        values = [value for _, value in pairs]
        weights = [frames for frames, _ in pairs]
        metric_summary[metric] = {
            "recordings_available": len(values),
            "macro_mean": sum(values) / len(values) if values else None,
            "frame_weighted_mean": (
                sum(value * weight for value, weight in zip(values, weights)) / sum(weights)
                if values else None
            ),
            "p50": _percentile(values, 0.50),
            "p90": _percentile(values, 0.90),
        }

    return {
        "schema_version": REPORT_VERSION,
        "recordings_evaluated": len(normalized),
        "total_frames_evaluated": total_frames,
        "total_duration_seconds": round(total_duration, 4),
        "sample_rate": contract[0],
        "hop_length": contract[1],
        "metrics": metric_summary,
        "quality_passed": False,
        "quality_thresholds_configured": False,
        "human_listening_review_required": True,
        "privacy": "aggregate metrics only; no recording, speaker, transcript, or path identifiers",
        "note": "Summary statistics are not a quality approval. Calibrate thresholds on representative held-out speakers.",
    }
