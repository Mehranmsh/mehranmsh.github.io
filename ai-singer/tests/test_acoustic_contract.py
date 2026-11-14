from __future__ import annotations

import pytest
from pydantic import ValidationError

from acoustic_contract import validate_acoustic_conditioning


def valid_payload() -> dict:
    return {
        "schema_version": "mehran.svs.conditioning.v1",
        "project_id": "project-fa-001",
        "language": "fa",
        "sample_rate": 48000,
        "duration_seconds": 2.0,
        "speaker_profile_id": "speaker-consented-01",
        "phonemes": [
            {"phoneme": "s", "start_seconds": 0.0, "end_seconds": 0.12},
            {"phoneme": "a", "start_seconds": 0.12, "end_seconds": 0.7},
            {"phoneme": "l", "start_seconds": 0.7, "end_seconds": 0.9},
        ],
        "notes": [
            {"midi_note": 60, "start_seconds": 0.0, "duration_seconds": 0.7, "velocity": 85},
            {"midi_note": 62, "start_seconds": 0.7, "duration_seconds": 0.8, "velocity": 80},
        ],
        "style": {
            "pitch_shift_semitones": 0,
            "energy": 0.7,
            "breathiness": 0.15,
            "vibrato_depth": 0.2,
            "vibrato_rate_hz": 5.2,
        },
    }


def test_valid_persian_conditioning_contract():
    result = validate_acoustic_conditioning(valid_payload())
    assert result.language == "fa"
    assert len(result.phonemes) == 3
    assert len(result.notes) == 2


def test_rejects_unknown_schema():
    payload = valid_payload()
    payload["schema_version"] = "other"
    with pytest.raises(ValidationError):
        validate_acoustic_conditioning(payload)


def test_rejects_unsupported_language():
    payload = valid_payload()
    payload["language"] = "xx"
    with pytest.raises(ValidationError):
        validate_acoustic_conditioning(payload)


def test_rejects_unsupported_sample_rate():
    payload = valid_payload()
    payload["sample_rate"] = 32000
    with pytest.raises(ValidationError):
        validate_acoustic_conditioning(payload)


def test_rejects_overlapping_phonemes():
    payload = valid_payload()
    payload["phonemes"][1]["start_seconds"] = 0.1
    with pytest.raises(ValidationError, match="non-overlapping"):
        validate_acoustic_conditioning(payload)


def test_rejects_out_of_order_notes():
    payload = valid_payload()
    payload["notes"][1]["start_seconds"] = 0.2
    with pytest.raises(ValidationError, match="ordered"):
        validate_acoustic_conditioning(payload)


def test_rejects_timeline_overrun():
    payload = valid_payload()
    payload["notes"][1]["duration_seconds"] = 2
    with pytest.raises(ValidationError, match="exceeds"):
        validate_acoustic_conditioning(payload)


def test_rejects_pitch_outside_midi_range():
    payload = valid_payload()
    payload["notes"][0]["midi_note"] = 128
    with pytest.raises(ValidationError):
        validate_acoustic_conditioning(payload)


def test_rejects_unknown_fields():
    payload = valid_payload()
    payload["raw_checkpoint_path"] = "/tmp/model.pt"
    with pytest.raises(ValidationError):
        validate_acoustic_conditioning(payload)


def test_rejects_invalid_vocal_style():
    payload = valid_payload()
    payload["style"]["breathiness"] = 1.5
    with pytest.raises(ValidationError):
        validate_acoustic_conditioning(payload)
