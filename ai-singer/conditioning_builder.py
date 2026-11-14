"""Build a validated acoustic-conditioning payload from reviewed timing and notes."""
from __future__ import annotations

from acoustic_contract import validate_acoustic_conditioning


def prepare_acoustic_conditioning(
    *,
    project_id: str,
    timing_plan: dict,
    notes: list[dict],
    duration_seconds: float,
    sample_rate: int = 48000,
    speaker_profile_id: str | None = None,
    style: dict | None = None,
) -> dict:
    if not isinstance(timing_plan, dict) or timing_plan.get("schema") != "mehran.phoneme-timing-plan.v1":
        raise ValueError("timing_plan must use mehran.phoneme-timing-plan.v1")
    if timing_plan.get("requires_review") is not True:
        raise ValueError("timing plan must retain human review status")
    if not isinstance(notes, list) or not notes:
        raise ValueError("notes must be a non-empty list")

    phoneme_spans = []
    mapping = []
    for syllable in timing_plan.get("syllables", []):
        for event in syllable.get("phonemes", []):
            start = float(event["start_seconds"])
            end = float(event["end_seconds"])
            overlaps = []
            for index, note in enumerate(notes):
                note_start = float(note["start_seconds"])
                note_end = note_start + float(note["duration_seconds"])
                if min(end, note_end) > max(start, note_start):
                    overlaps.append(index)
            if not overlaps:
                raise ValueError("every phoneme must overlap at least one supplied note")
            phoneme_spans.append({
                "phoneme": event["phoneme"],
                "start_seconds": start,
                "end_seconds": end,
            })
            mapping.append({
                "phoneme_index": len(phoneme_spans) - 1,
                "note_indices": overlaps,
                "mapping_source": "temporal_overlap_of_human_supplied_intervals",
            })

    payload = {
        "schema_version": "mehran.svs.conditioning.v1",
        "project_id": project_id,
        "language": "fa",
        "sample_rate": sample_rate,
        "duration_seconds": duration_seconds,
        "speaker_profile_id": speaker_profile_id,
        "phonemes": phoneme_spans,
        "notes": notes,
        "style": style or {},
    }
    validated = validate_acoustic_conditioning(payload)
    return {
        "conditioning": validated.model_dump(mode="json"),
        "phoneme_note_mapping": mapping,
        "mapping_review_required": True,
        "mapping_is_acoustic_alignment": False,
        "accepted_for_inference": False,
        "audio_generated": False,
    }
