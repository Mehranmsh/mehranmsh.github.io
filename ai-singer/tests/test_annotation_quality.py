import unittest

from annotation_quality import (
    AnnotationQualityError,
    analyze_annotation,
    summarize_annotation_quality,
)


def record():
    return {
        "duration_seconds": 1.0,
        "phoneme_alignment": [
            {"phoneme": "s", "start_seconds": 0.0, "end_seconds": 0.1},
            {"phoneme": "æ", "start_seconds": 0.2, "end_seconds": 0.8},
            {"phoneme": "l", "start_seconds": 0.8, "end_seconds": 1.0},
        ],
        "notes": [
            {"midi_note": 60, "start_seconds": 0.3, "duration_seconds": 0.4},
        ],
    }


class AnnotationQualityTests(unittest.TestCase):
    def test_reports_phoneme_coverage_internal_gap_and_vowel_note_coverage(self):
        result = analyze_annotation(record())
        self.assertAlmostEqual(result["phoneme_time_coverage"], 0.9)
        self.assertEqual(result["internal_gap_count"], 1)
        self.assertAlmostEqual(result["maximum_internal_gap_seconds"], 0.1)
        self.assertAlmostEqual(result["leading_unannotated_seconds"], 0.0)
        self.assertAlmostEqual(result["trailing_unannotated_seconds"], 0.0)
        self.assertAlmostEqual(result["vowel_note_time_coverage"], 2 / 3)
        self.assertEqual(result["vowel_count"], 1)

    def test_silence_and_rests_are_reported_without_default_warnings(self):
        result = summarize_annotation_quality([record()])
        self.assertEqual(result["warnings"], [])
        self.assertEqual(result["thresholds"]["minimum_phoneme_coverage"], None)
        self.assertEqual(result["edge_unannotated_audio"]["recordings_with_leading_audio"], 0)
        self.assertEqual(result["edge_unannotated_audio"]["recordings_with_trailing_audio"], 0)

    def test_optional_thresholds_create_aggregate_warnings_only(self):
        item = record()
        item["phoneme_alignment"][0]["start_seconds"] = 0.12
        item["phoneme_alignment"][0]["end_seconds"] = 0.18
        item["phoneme_alignment"][1]["start_seconds"] = 0.30
        result = summarize_annotation_quality(
            [item],
            minimum_phoneme_coverage=0.95,
            minimum_vowel_note_coverage=0.8,
            maximum_internal_gap_seconds=0.05,
            maximum_edge_unannotated_seconds=0.05,
        )
        self.assertEqual(
            {item["code"] for item in result["warnings"]},
            {
                "low_phoneme_time_coverage",
                "low_vowel_note_time_coverage",
                "long_internal_annotation_gap",
                "excessive_edge_unannotated_audio",
            },
        )
        self.assertTrue(all(item["recordings"] == 1 for item in result["warnings"]))
        self.assertNotIn("recording_id", str(result))
        self.assertNotIn("speaker_id", str(result))

    def test_edge_threshold_flags_unannotated_audio_only_when_configured(self):
        item = record()
        item["phoneme_alignment"][0]["start_seconds"] = 0.12
        item["phoneme_alignment"][0]["end_seconds"] = 0.18
        summary = summarize_annotation_quality(
            [item], maximum_edge_unannotated_seconds=0.05
        )
        self.assertEqual(summary["warnings"], [
            {"code": "excessive_edge_unannotated_audio", "recordings": 1}
        ])

    def test_no_vowels_reports_null_vowel_note_coverage(self):
        item = record()
        item["phoneme_alignment"] = [
            {"phoneme": "s", "start_seconds": 0.0, "end_seconds": 0.5},
            {"phoneme": "l", "start_seconds": 0.5, "end_seconds": 1.0},
        ]
        result = analyze_annotation(item)
        self.assertIsNone(result["vowel_note_time_coverage"])

    def test_rejects_invalid_threshold(self):
        with self.assertRaises(AnnotationQualityError):
            summarize_annotation_quality([record()], minimum_phoneme_coverage=1.5)

    def test_empty_collection_returns_null_aggregates(self):
        result = summarize_annotation_quality([])
        self.assertEqual(result["recordings_analyzed"], 0)
        self.assertIsNone(result["phoneme_time_coverage"]["mean"])
        self.assertIsNone(result["vowel_note_time_coverage"]["mean"])


if __name__ == "__main__":
    unittest.main()
