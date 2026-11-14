"""Human-directed phoneme timing plans; no acoustic alignment is inferred."""
from __future__ import annotations

import math

from phoneme_inventory import validate_phoneme_sequence


class PhonemeTimingError(ValueError):
    pass


def build_phoneme_timing_plan(syllables: list[dict]) -> dict:
    if not isinstance(syllables, list) or not syllables or len(syllables) > 1000:
        raise PhonemeTimingError("syllables must be a non-empty list of at most 1000 items")

    output = []
    previous_end = 0.0
    total_phonemes = 0
    for index, item in enumerate(syllables):
        if not isinstance(item, dict):
            raise PhonemeTimingError(f"syllable {index} must be an object")
        try:
            start = item["start_seconds"]
            end = item["end_seconds"]
            phones = validate_phoneme_sequence(item["phonemes"])
            weights = item["duration_weights"]
        except KeyError as exc:
            raise PhonemeTimingError(f"syllable {index} is missing {exc.args[0]}") from exc
        if (isinstance(start, bool) or isinstance(end, bool)
                or not isinstance(start, (int, float)) or not isinstance(end, (int, float))
                or not math.isfinite(start) or not math.isfinite(end)):
            raise PhonemeTimingError("syllable boundaries must be finite numbers")
        start, end = float(start), float(end)
        if start < 0 or end <= start or end > 600:
            raise PhonemeTimingError("syllable timing must satisfy 0 <= start < end <= 600 seconds")
        if index and start < previous_end - 1e-9:
            raise PhonemeTimingError("syllable timing windows must be chronological and non-overlapping")
        if not isinstance(weights, list) or len(weights) != len(phones):
            raise PhonemeTimingError("duration_weights must contain one positive weight per phoneme")
        if any(isinstance(w, bool) or not isinstance(w, (int, float)) or not math.isfinite(w) or w <= 0 for w in weights):
            raise PhonemeTimingError("every phoneme duration weight must be a finite positive number")
        weight_sum = sum(weights)
        if not math.isfinite(weight_sum) or weight_sum <= 0:
            raise PhonemeTimingError("duration weight sum must be finite and positive")

        duration = end - start
        cursor = start
        events = []
        for phone_index, (phone, weight) in enumerate(zip(phones, weights)):
            phone_end = end if phone_index == len(phones) - 1 else start + duration * sum(weights[:phone_index + 1]) / weight_sum
            events.append({
                "phoneme": phone,
                "phoneme_index": phone_index,
                "start_seconds": round(cursor, 6),
                "end_seconds": round(phone_end, 6),
                "duration_seconds": round(phone_end - cursor, 6),
            })
            cursor = phone_end
        output.append({
            "syllable_index": index,
            "text": str(item.get("text", "")),
            "start_seconds": round(start, 6),
            "end_seconds": round(end, 6),
            "phonemes": events,
            "timing_source": "human_duration_weights",
        })
        previous_end = end
        total_phonemes += len(phones)

    return {
        "schema": "mehran.phoneme-timing-plan.v1",
        "syllable_count": len(output),
        "phoneme_count": total_phonemes,
        "duration_seconds": round(max(item["end_seconds"] for item in output), 6),
        "syllables": output,
        "requires_review": True,
        "acoustic_alignment_performed": False,
        "audio_generated": False,
        "message": "A timing plan was calculated from human-supplied syllable windows and duration weights; it is not acoustic forced alignment.",
    }
