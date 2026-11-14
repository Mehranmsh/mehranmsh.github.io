from __future__ import annotations

import unittest

from speaker_reference import SpeakerReferenceError, build_speaker_reference_map


def record(recording_id, *, speaker="speaker-a", split="train", audio=None, reference="ref"):
    return {
        "recording_id": recording_id,
        "speaker_id": speaker,
        "split": split,
        "audio_path": audio or f"{recording_id}.wav",
        "speaker_reference_recording_id": reference,
    }


class SpeakerReferenceMapTests(unittest.TestCase):
    def test_accepts_distinct_same_speaker_reference_in_same_split(self):
        target = record("target", reference="reference")
        reference = record("reference", reference="target")
        self.assertEqual(
            build_speaker_reference_map([target, reference], "train"),
            {"target": "reference", "reference": "target"},
        )

    def test_rejects_missing_reference(self):
        with self.assertRaisesRegex(SpeakerReferenceError, "does not exist"):
            build_speaker_reference_map([record("target", reference="missing")], "train")

    def test_rejects_different_speaker(self):
        with self.assertRaisesRegex(SpeakerReferenceError, "same speaker"):
            build_speaker_reference_map([
                record("target", reference="reference"),
                record("reference", speaker="speaker-b"),
            ], "train")

    def test_rejects_cross_split_reference(self):
        with self.assertRaisesRegex(SpeakerReferenceError, "same split"):
            build_speaker_reference_map([
                record("target", reference="validation-ref"),
                record("validation-ref", split="validation"),
            ], "train")

    def test_rejects_same_recording_or_same_audio_path(self):
        with self.assertRaisesRegex(SpeakerReferenceError, "different recording"):
            build_speaker_reference_map([record("target", reference="target")], "train")
        with self.assertRaisesRegex(SpeakerReferenceError, "different audio files"):
            build_speaker_reference_map([
                record("target", reference="reference", audio="same.wav"),
                record("reference", audio="same.wav"),
            ], "train")

    def test_ignores_other_splits(self):
        self.assertEqual(
            build_speaker_reference_map([
                record("train-a", reference="train-b"),
                record("train-b", reference="train-a"),
                record("validation-a", split="validation", reference="validation-b"),
            ], "train"),
            {"train-a": "train-b", "train-b": "train-a"},
        )


if __name__ == "__main__":
    unittest.main()
