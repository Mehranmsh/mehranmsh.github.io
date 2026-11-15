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


    def test_phoneme_duration_thresholds_are_opt_in_and_aggregate_only(self):
        result = summarize_annotation_quality(
            [record()],
            minimum_phoneme_duration_seconds=0.15,
            maximum_phoneme_duration_seconds=0.5,
        )
        self.assertEqual(
            {item["code"] for item in result["warnings"]},
            {"very_short_phoneme_span", "very_long_phoneme_span"},
        )
        self.assertEqual(result["phoneme_durations"]["minimum_seconds"], 0.1)
        self.assertAlmostEqual(result["phoneme_durations"]["maximum_seconds"], 0.6)
        self.assertAlmostEqual(result["phoneme_durations"]["shortest_per_recording_seconds"]["p50"], 0.1)
        self.assertAlmostEqual(result["phoneme_durations"]["shortest_per_recording_seconds"]["p90"], 0.1)
        self.assertAlmostEqual(result["phoneme_durations"]["longest_per_recording_seconds"]["p50"], 0.6)
        self.assertAlmostEqual(result["phoneme_durations"]["longest_per_recording_seconds"]["p90"], 0.6)
        self.assertTrue(all(item["recordings"] == 1 for item in result["warnings"]))
        self.assertNotIn("recording_id", str(result))

    def test_rejects_inverted_phoneme_duration_thresholds(self):
        with self.assertRaises(AnnotationQualityError):
            summarize_annotation_quality(
                [record()],
                minimum_phoneme_duration_seconds=0.5,
                maximum_phoneme_duration_seconds=0.1,
            )

    def test_no_vowels_reports_null_vowel_note_coverage(self):
        item = record()
        item["phoneme_alignment"] = [
            {"phoneme": "s", "start_seconds": 0.0, "end_seconds": 0.5},
            {"phoneme": "l", "start_seconds": 0.5, "end_seconds": 1.0},
        ]
        result = analyze_annotation(item)
        self.assertIsNone(result["vowel_note_time_coverage"])

    def test_reports_reviewed_syllable_metrics_without_exposing_labels(self):
        item = record()
        item["alignment_status"] = "reviewed"
        item["syllable_alignment"] = [
            {"text": "سَ", "start_seconds": 0.0, "end_seconds": 0.2,
             "phoneme_start_index": 0, "phoneme_end_index": 2},
            {"text": "ل", "start_seconds": 0.2, "end_seconds": 1.0,
             "phoneme_start_index": 2, "phoneme_end_index": 3},
        ]
        result = analyze_annotation(item)
        self.assertEqual(result["syllable_count"], 2)
        self.assertEqual(result["syllable_durations_seconds"], [0.2, 0.8])
        self.assertEqual(result["phonemes_per_syllable"], [2, 1])
        summary = summarize_annotation_quality([item])
        metrics = summary["syllable_alignment"]
        self.assertEqual(metrics["recordings_with_syllables"], 1)
        self.assertEqual(metrics["total_syllables"], 2)
        self.assertAlmostEqual(metrics["duration_seconds"]["mean"], 0.5)
        self.assertEqual(metrics["duration_seconds"]["p50"], 0.2)
        self.assertEqual(metrics["duration_seconds"]["p90"], 0.8)
        self.assertAlmostEqual(metrics["phonemes_per_syllable"]["mean"], 1.5)
        self.assertNotIn("سَ", str(summary))
        self.assertNotIn("text", str(summary))

    def test_rejects_unreviewed_syllable_metrics(self):
        item = record()
        item["alignment_status"] = "unreviewed"
        item["syllable_alignment"] = [
            {"text": "سَ", "start_seconds": 0.0, "end_seconds": 1.0,
             "phoneme_start_index": 0, "phoneme_end_index": 3},
        ]
        with self.assertRaisesRegex(AnnotationQualityError, "must be reviewed"):
            analyze_annotation(item)

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
