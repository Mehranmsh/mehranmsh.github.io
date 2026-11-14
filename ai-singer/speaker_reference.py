"""Leakage-safe manifest pairing for reference-audio speaker conditioning."""
from __future__ import annotations


class SpeakerReferenceError(ValueError):
    """Raised when a speaker reference is missing, unsafe, or split-leaking."""


def build_speaker_reference_map(records: list[dict], split: str) -> dict[str, str]:
    """Map each target recording to a distinct reference recording of its speaker.

    The reference must be present in the same manifest and split, belong to the
    same speaker, and use a different recording ID and audio path. Consent and
    rights for both files are enforced by the manifest validator.
    """
    if split not in {"train", "validation", "test"}:
        raise SpeakerReferenceError("split must be train, validation, or test")
    if not isinstance(records, list) or not records:
        raise SpeakerReferenceError("manifest records are required")
    by_id = {}
    for record in records:
        if not isinstance(record, dict):
            raise SpeakerReferenceError("every manifest record must be an object")
        recording_id = record.get("recording_id")
        if not isinstance(recording_id, str) or not recording_id.strip():
            raise SpeakerReferenceError("every record requires a recording_id")
        if recording_id in by_id:
            raise SpeakerReferenceError("recording_id values must be unique")
        by_id[recording_id] = record

    mapping = {}
    for target in records:
        if target.get("split") != split or target.get("speaker_reference_only") is True:
            continue
        target_id = target["recording_id"]
        reference_id = target.get("speaker_reference_recording_id")
        if not isinstance(reference_id, str) or not reference_id.strip():
            raise SpeakerReferenceError(f"{target_id}: speaker_reference_recording_id is required")
        if reference_id == target_id:
            raise SpeakerReferenceError(f"{target_id}: reference must be a different recording")
        reference = by_id.get(reference_id)
        if reference is None:
            raise SpeakerReferenceError(f"{target_id}: speaker reference does not exist in manifest")
        if reference.get("split") != split:
            raise SpeakerReferenceError(f"{target_id}: speaker reference must belong to the same split")
        if reference.get("speaker_id") != target.get("speaker_id"):
            raise SpeakerReferenceError(f"{target_id}: speaker reference must belong to the same speaker")
        if reference.get("audio_path") == target.get("audio_path"):
            raise SpeakerReferenceError(f"{target_id}: target and reference must use different audio files")
        mapping[target_id] = reference_id
    if not mapping:
        raise SpeakerReferenceError(f"manifest contains no records for split: {split}")
    return mapping
