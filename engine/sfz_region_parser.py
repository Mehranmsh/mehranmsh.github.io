"""Strict parser for the subset of SFZ region opcodes used by MEHRAN bank imports.

This module does not render audio or reinterpret SFZ crossfades. It preserves the
source's key zones, velocity limits, crossfade ranges, offsets, tuning and gain.
"""
from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Any


_SUPPORTED_REGION_OPCODES = {
    "sample", "pitch_keycenter", "lokey", "hikey", "lovel", "hivel",
    "offset", "tune", "volume", "xfout_lovel", "xfout_hivel",
    "xfin_lovel", "xfin_hivel",
}
_FLOAT_OPCODES = {"tune", "volume"}
_ASSIGNMENT = re.compile(r"([A-Za-z][A-Za-z0-9_]*)=(.*?)(?=\s+[A-Za-z][A-Za-z0-9_]*=|$)")


def _number(opcode: str, raw: str) -> int | float:
    try:
        value = float(raw) if opcode in _FLOAT_OPCODES else int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid SFZ {opcode} value: {raw}") from exc
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        raise ValueError(f"SFZ {opcode} must be finite")
    return value


def parse_sfz_regions(source: str) -> list[dict[str, Any]]:
    """Parse <region> blocks while retaining all supported playback directives."""
    if not isinstance(source, str) or not source.strip():
        raise ValueError("SFZ source must be non-empty text")

    regions: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line_number, raw_line in enumerate(source.splitlines(), 1):
        line = raw_line.split("//", 1)[0].strip()
        if not line:
            continue
        if line.startswith("<") and line.endswith(">"):
            tag = line[1:-1].strip().lower()
            if tag == "region":
                if current is not None:
                    regions.append(_validate_region(current, len(regions) + 1))
                current = {}
            elif tag in {"group", "global", "control", "master", "曲"}:
                # Non-region headers do not contribute sample mapping directives.
                continue
            else:
                current = None
            continue
        if current is None:
            continue
        matches = list(_ASSIGNMENT.finditer(line))
        if not matches or line[:matches[0].start()].strip():
            raise ValueError(f"Malformed SFZ assignment on line {line_number}")
        for position, match in enumerate(matches):
            if position and line[matches[position - 1].end():match.start()].strip():
                raise ValueError(f"Malformed SFZ assignment on line {line_number}")
            opcode, raw_value = match.groups()
            raw_value = raw_value.strip()
            if not raw_value:
                raise ValueError(f"Empty SFZ value on line {line_number}: {opcode}")
            if opcode not in _SUPPORTED_REGION_OPCODES:
                raise ValueError(f"Unsupported SFZ region opcode on line {line_number}: {opcode}")
            if opcode in current:
                raise ValueError(f"Duplicate SFZ opcode in one region: {opcode}")
            current[opcode] = raw_value if opcode == "sample" else _number(opcode, raw_value)

    if current is not None:
        regions.append(_validate_region(current, len(regions) + 1))
    if not regions:
        raise ValueError("SFZ contains no supported <region> blocks")
    return regions


def _validate_region(raw: dict[str, Any], index: int) -> dict[str, Any]:
    sample = raw.get("sample")
    if not isinstance(sample, str) or not sample:
        raise ValueError(f"SFZ region {index} has no sample path")
    path = PurePosixPath(sample.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"SFZ region {index} sample path escapes the bank")

    required = ("pitch_keycenter", "lokey", "hikey")
    if any(key not in raw for key in required):
        raise ValueError(f"SFZ region {index} is missing its root note or key zone")
    root, low, high = (int(raw[key]) for key in required)
    if not 0 <= low <= root <= high <= 127:
        raise ValueError(f"SFZ region {index} has an invalid MIDI key zone")

    velocity_low = int(raw.get("lovel", 0))
    velocity_high = int(raw.get("hivel", 127))
    if not 0 <= velocity_low <= velocity_high <= 127:
        raise ValueError(f"SFZ region {index} has an invalid velocity range")

    xfade_out = _crossfade_range(raw, "xfout")
    xfade_in = _crossfade_range(raw, "xfin")
    if xfade_out and xfade_in:
        raise ValueError(f"SFZ region {index} cannot fade both in and out")
    offset = int(raw.get("offset", 0))
    if offset < 0:
        raise ValueError(f"SFZ region {index} has a negative sample offset")

    return {
        "sample": sample,
        "pitch_keycenter": root,
        "key_range": [low, high],
        "velocity_range": [velocity_low, velocity_high],
        "offset_sample_points": offset,
        "tune_cents": float(raw.get("tune", 0.0)),
        "volume_db": float(raw.get("volume", 0.0)),
        "crossfade": (
            {"direction": "out", "velocity_range": xfade_out} if xfade_out else
            {"direction": "in", "velocity_range": xfade_in} if xfade_in else None
        ),
        "source_opcodes": dict(raw),
    }


def _crossfade_range(raw: dict[str, Any], prefix: str) -> list[int] | None:
    low_key, high_key = f"{prefix}_lovel", f"{prefix}_hivel"
    if (low_key in raw) != (high_key in raw):
        raise ValueError(f"SFZ {prefix} crossfade requires both low and high velocity bounds")
    if low_key not in raw:
        return None
    low, high = int(raw[low_key]), int(raw[high_key])
    if not 0 <= low <= high <= 127:
        raise ValueError(f"Invalid SFZ {prefix} crossfade velocity range")
    return [low, high]
