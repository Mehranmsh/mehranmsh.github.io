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
    syllable_alignment = []
    mapping = []
    for syllable in timing_plan.get("syllables", []):
        phoneme_start_index = len(phoneme_spans)
        syllable_events = syllable.get("phonemes", [])
        for event in syllable_events:
            start = float(event["start_seconds"])
            end = float(event["end_seconds"])
            overlaps = []
            overlap_intervals = []
            for index, note in enumerate(notes):
                note_start = float(note["start_seconds"])
                note_end = note_start + float(note["duration_seconds"])
                overlap_start = max(start, note_start)
                overlap_end = min(end, note_end)
                if overlap_end > overlap_start:
                    overlaps.append(index)
                    overlap_intervals.append((overlap_start, overlap_end))
            if not overlaps:
                raise ValueError("every phoneme must overlap at least one supplied note")
            # Measure union coverage so simultaneous/polyphonic notes do not
            # inflate the fraction of a phoneme covered by the melody.
            covered_seconds = 0.0
            merged_start = merged_end = None
            for interval_start, interval_end in sorted(overlap_intervals):
                if merged_start is None:
                    merged_start, merged_end = interval_start, interval_end
                elif interval_start <= merged_end:
                    merged_end = max(merged_end, interval_end)
                else:
                    covered_seconds += merged_end - merged_start
                    merged_start, merged_end = interval_start, interval_end
            if merged_start is not None:
                covered_seconds += merged_end - merged_start
            phoneme_duration = end - start
            coverage_ratio = min(1.0, covered_seconds / phoneme_duration)
            phoneme_spans.append({
                "phoneme": event["phoneme"],
                "start_seconds": start,
                "end_seconds": end,
            })
            mapping.append({
                "phoneme_index": len(phoneme_spans) - 1,
                "note_indices": overlaps,
                "phoneme_duration_seconds": phoneme_duration,
                "note_covered_seconds": covered_seconds,
                "note_coverage_ratio": coverage_ratio,
                "mapping_source": "temporal_overlap_of_human_supplied_intervals",
            })
        if not syllable_events:
            raise ValueError("every reviewed syllable must contain at least one phoneme")
        syllable_alignment.append({
            "text": str(syllable.get("text", "")),
            "start_seconds": min(float(event["start_seconds"]) for event in syllable_events),
            "end_seconds": max(float(event["end_seconds"]) for event in syllable_events),
            "phoneme_start_index": phoneme_start_index,
            "phoneme_end_index": len(phoneme_spans),
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
        "syllable_alignment": syllable_alignment,
        "phoneme_note_mapping": mapping,
        "mapping_review_required": True,
        "mapping_is_acoustic_alignment": False,
        "accepted_for_inference": False,
        "audio_generated": False,
    }
