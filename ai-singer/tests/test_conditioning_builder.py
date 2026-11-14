import unittest

from conditioning_builder import prepare_acoustic_conditioning


class ConditioningBuilderTests(unittest.TestCase):
    def timing_plan(self):
        return {
            "schema": "mehran.phoneme-timing-plan.v1",
            "requires_review": True,
            "syllables": [{
                "phonemes": [
                    {"phoneme": "s", "start_seconds": 0.0, "end_seconds": 0.2},
                    {"phoneme": "æ", "start_seconds": 0.2, "end_seconds": 0.8},
                ]
            }],
        }

    def notes(self):
        return [
            {"midi_note": 60, "start_seconds": 0.0, "duration_seconds": 0.5},
            {"midi_note": 62, "start_seconds": 0.5, "duration_seconds": 0.5},
        ]

    def test_builds_conditioning_and_explicit_note_mapping(self):
        result = prepare_acoustic_conditioning(
            project_id="project-1", timing_plan=self.timing_plan(),
            notes=self.notes(), duration_seconds=1.0,
        )
        self.assertEqual(result["conditioning"]["schema_version"], "mehran.svs.conditioning.v1")
        self.assertEqual(result["phoneme_note_mapping"][0]["note_indices"], [0])
        self.assertEqual(result["phoneme_note_mapping"][1]["note_indices"], [0, 1])
        self.assertTrue(result["mapping_review_required"])
        self.assertFalse(result["mapping_is_acoustic_alignment"])
        self.assertFalse(result["accepted_for_inference"])

    def test_rejects_unreviewed_plan(self):
        plan = self.timing_plan()
        plan["requires_review"] = False
        with self.assertRaisesRegex(ValueError, "human review"):
            prepare_acoustic_conditioning(
                project_id="project-1", timing_plan=plan,
                notes=self.notes(), duration_seconds=1.0,
            )

    def test_rejects_phoneme_without_note_overlap(self):
        plan = self.timing_plan()
        plan["syllables"][0]["phonemes"][0]["start_seconds"] = 0.95
        plan["syllables"][0]["phonemes"][0]["end_seconds"] = 1.0
        with self.assertRaisesRegex(ValueError, "overlap"):
            prepare_acoustic_conditioning(
                project_id="project-1", timing_plan=plan,
                notes=self.notes(), duration_seconds=1.0,
            )


if __name__ == "__main__":
    unittest.main()
