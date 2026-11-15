"""Aggregate diagnostics for reviewed Persian phoneme/MIDI alignment.

This module reports timing coverage and vowel-to-note alignment without
assuming that every silence, consonant onset, or musical rest is an error.
Thresholds are opt-in and warnings never expose recording or speaker IDs.
"""
from __future__ import annotations

import math
from collections.abc import Iterable


class AnnotationQualityError(ValueError):
    """Raised when annotation diagnostics receive malformed input."""


def _threshold(value: float | None, name: str, *, maximum: float | None = None) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise AnnotationQualityError(f"{name} must be a finite number")
    result = float(value)
    if result < 0 or (maximum is not None and result > maximum):
        raise AnnotationQualityError(f"{name} is outside its permitted range")
    return result


def analyze_annotation(record: dict) -> dict:
    """Return timing diagnostics for one already manifest-validated Persian record."""
    duration = record.get("duration_seconds")
    spans = record.get("phoneme_alignment")
    notes = record.get("notes")
    if (isinstance(duration, bool) or not isinstance(duration, (int, float))
            or not math.isfinite(duration) or duration <= 0):
        raise AnnotationQualityError("record duration must be a positive finite number")
    if not isinstance(spans, list) or not spans or not isinstance(notes, list) or not notes:
        raise AnnotationQualityError("reviewed phoneme and MIDI annotations are required")

    phoneme_duration = 0.0
    phoneme_span_durations = []
    internal_gaps = []
    vowel_duration = 0.0
    vowel_note_overlap = 0.0
    previous_end = None
    vowel_spans = []
    for span in spans:
        if not isinstance(span, dict):
            raise AnnotationQualityError("invalid phoneme span")
        start, end = span.get("start_seconds"), span.get("end_seconds")
        symbol = span.get("phoneme")
        if (isinstance(start, bool) or isinstance(end, bool)
                or not isinstance(start, (int, float)) or not isinstance(end, (int, float))
                or not math.isfinite(start) or not math.isfinite(end)
                or start < 0 or end <= start or end > duration + 0.02
                or not isinstance(symbol, str) or not symbol.strip()):
            raise AnnotationQualityError("invalid phoneme timing or symbol")
        if previous_end is not None and start > previous_end:
            internal_gaps.append(float(start - previous_end))
        previous_end = float(end)
        span_duration = float(end - start)
        phoneme_duration += span_duration
        phoneme_span_durations.append(span_duration)
        vowel_spans.append((symbol, float(start), float(end)))
    from phoneme_inventory import PHONEME_FEATURES, canonicalize_phoneme

    for symbol, start, end in vowel_spans:
        feature = PHONEME_FEATURES.get(canonicalize_phoneme(symbol))
        if feature and feature["kind"] == "vowel":
            vowel_duration += end - start
            for note in notes:
                note_start = float(note["start_seconds"])
                note_end = note_start + float(note["duration_seconds"])
                vowel_note_overlap += max(0.0, min(end, note_end) - max(start, note_start))

    coverage = min(1.0, phoneme_duration / float(duration))
    leading_unannotated = float(vowel_spans[0][1])
    trailing_unannotated = max(0.0, float(duration) - float(vowel_spans[-1][2]))
    vowel_note_coverage = (
        min(1.0, vowel_note_overlap / vowel_duration) if vowel_duration > 0 else None
    )
    return {
        "phoneme_count": len(spans),
        "minimum_phoneme_duration_seconds": min(phoneme_span_durations),
        "maximum_phoneme_duration_seconds": max(phoneme_span_durations),
        "vowel_count": sum(
            1 for symbol, _, _ in vowel_spans
            if PHONEME_FEATURES.get(canonicalize_phoneme(symbol), {}).get("kind") == "vowel"
        ),
        "note_count": len(notes),
        "phoneme_time_coverage": coverage,
        "internal_gap_count": len(internal_gaps),
        "maximum_internal_gap_seconds": max(internal_gaps, default=0.0),
        "leading_unannotated_seconds": leading_unannotated,
        "trailing_unannotated_seconds": trailing_unannotated,
        "vowel_note_time_coverage": vowel_note_coverage,
    }


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def summarize_annotation_quality(
    records: Iterable[dict],
    *,
    minimum_phoneme_coverage: float | None = None,
    minimum_vowel_note_coverage: float | None = None,
    maximum_internal_gap_seconds: float | None = None,
    maximum_edge_unannotated_seconds: float | None = None,
    minimum_phoneme_duration_seconds: float | None = None,
    maximum_phoneme_duration_seconds: float | None = None,
) -> dict:
    """Summarize annotations and apply only explicitly configured warning thresholds."""
    min_phoneme = _threshold(minimum_phoneme_coverage, "minimum_phoneme_coverage", maximum=1.0)
    min_vowel = _threshold(minimum_vowel_note_coverage, "minimum_vowel_note_coverage", maximum=1.0)
    max_gap = _threshold(maximum_internal_gap_seconds, "maximum_internal_gap_seconds")
    max_edge = _threshold(maximum_edge_unannotated_seconds, "maximum_edge_unannotated_seconds")
    min_phoneme_duration = _threshold(minimum_phoneme_duration_seconds, "minimum_phoneme_duration_seconds")
    max_phoneme_duration = _threshold(maximum_phoneme_duration_seconds, "maximum_phoneme_duration_seconds")
    if min_phoneme_duration is not None and max_phoneme_duration is not None and min_phoneme_duration > max_phoneme_duration:
        raise AnnotationQualityError("minimum_phoneme_duration_seconds must not exceed maximum_phoneme_duration_seconds")
    diagnostics = [analyze_annotation(record) for record in records]
    coverage = [item["phoneme_time_coverage"] for item in diagnostics]
    vowel_coverage = [
        item["vowel_note_time_coverage"] for item in diagnostics
        if item["vowel_note_time_coverage"] is not None
    ]
    gaps = [item["maximum_internal_gap_seconds"] for item in diagnostics]
    leading_gaps = [item["leading_unannotated_seconds"] for item in diagnostics]
    trailing_gaps = [item["trailing_unannotated_seconds"] for item in diagnostics]
    shortest_phonemes = [item["minimum_phoneme_duration_seconds"] for item in diagnostics]
    longest_phonemes = [item["maximum_phoneme_duration_seconds"] for item in diagnostics]
    warnings = []
    if min_phoneme is not None:
        count = sum(value < min_phoneme for value in coverage)
        if count:
            warnings.append({"code": "low_phoneme_time_coverage", "recordings": count})
    if min_vowel is not None:
        count = sum(value < min_vowel for value in vowel_coverage)
        if count:
            warnings.append({"code": "low_vowel_note_time_coverage", "recordings": count})
    if max_gap is not None:
        count = sum(value > max_gap for value in gaps)
        if count:
            warnings.append({"code": "long_internal_annotation_gap", "recordings": count})
    if min_phoneme_duration is not None:
        count = sum(value < min_phoneme_duration for value in shortest_phonemes)
        if count:
            warnings.append({"code": "very_short_phoneme_span", "recordings": count})
    if max_phoneme_duration is not None:
        count = sum(value > max_phoneme_duration for value in longest_phonemes)
        if count:
            warnings.append({"code": "very_long_phoneme_span", "recordings": count})
    if max_edge is not None:
        count = sum(
            item["leading_unannotated_seconds"] > max_edge
            or item["trailing_unannotated_seconds"] > max_edge
            for item in diagnostics
        )
        if count:
            warnings.append({"code": "excessive_edge_unannotated_audio", "recordings": count})
    return {
        "recordings_analyzed": len(diagnostics),
        "phoneme_time_coverage": {
            "mean": sum(coverage) / len(coverage) if coverage else None,
            "p10": _percentile(coverage, 0.10),
            "p50": _percentile(coverage, 0.50),
        },
        "vowel_note_time_coverage": {
            "mean": sum(vowel_coverage) / len(vowel_coverage) if vowel_coverage else None,
            "recordings_with_vowels": len(vowel_coverage),
        },
        "phoneme_durations": {
            "minimum_seconds": min(shortest_phonemes, default=None),
            "maximum_seconds": max(longest_phonemes, default=None),
        },
        "internal_gaps": {
            "total": sum(item["internal_gap_count"] for item in diagnostics),
            "maximum_seconds": max(gaps, default=0.0) if gaps else None,
        },
        "edge_unannotated_audio": {
            "maximum_leading_seconds": max(leading_gaps, default=0.0) if leading_gaps else None,
            "maximum_trailing_seconds": max(trailing_gaps, default=0.0) if trailing_gaps else None,
            "recordings_with_leading_audio": sum(value > 0 for value in leading_gaps),
            "recordings_with_trailing_audio": sum(value > 0 for value in trailing_gaps),
        },
        "warnings": warnings,
        "thresholds": {
            "minimum_phoneme_coverage": min_phoneme,
            "minimum_vowel_note_coverage": min_vowel,
            "maximum_internal_gap_seconds": max_gap,
            "maximum_edge_unannotated_seconds": max_edge,
            "minimum_phoneme_duration_seconds": min_phoneme_duration,
            "maximum_phoneme_duration_seconds": max_phoneme_duration,
        },
    }
