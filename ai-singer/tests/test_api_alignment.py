import unittest

from fastapi import HTTPException

from server import align_job


def make_job():
    return {
        "schema": "mehran.svs.job.v1",
        "project": {
            "id": "integration-test",
            "name": "Alignment test",
            "language": "Persian",
            "tempo": 120,
            "lyrics": "سلام",
        },
        "singer": {"name": "Lead Vocal", "language": "Persian", "role": "Lead"},
        "melody": {
            "source": "project_pattern",
            "noteEvents": [
                {"note": "C4", "startStep": 0, "lengthSteps": 4, "velocity": 90},
                {"note": "D4", "startStep": 4, "lengthSteps": 4, "velocity": 90},
            ],
        },
        "render": {"format": "wav", "sampleRate": 48000, "output": "isolated_vocal_stem"},
        "engine": {
            "provider": "MEHRAN",
            "deployment": "self-hosted",
            "modelId": "mehran-svs-native",
            "thirdPartyGenerationApi": False,
        },
    }


class AlignmentApiTests(unittest.TestCase):
    def test_align_endpoint_accepts_reviewed_piano_roll_mapping(self):
        result = align_job({
            "job": make_job(),
            "pronunciation_overrides": {"سلام": "سَ-لام"},
            "manual_note_groups": [[0], [1]],
        })
        self.assertEqual(result["melody_source"], "project_pattern")
        self.assertEqual(result["syllable_count"], 2)
        self.assertEqual(result["note_count"], 2)
        self.assertTrue(result["alignment_ready"])
        self.assertEqual(result["alignment"][0]["notes"], ["C4"])
        self.assertEqual(result["alignment"][1]["notes"], ["D4"])
        self.assertFalse(result["generation_ready"])
        self.assertFalse(result["third_party_generation_api"])

    def test_align_endpoint_uses_human_edited_syllable_timing(self):
        result = align_job({
            "job": make_job(),
            "pronunciation_overrides": {"سلام": "سَ-لام"},
            "manual_note_groups": [[0], [1]],
            "manual_timing_windows": [
                {"start_seconds": 0.05, "end_seconds": 0.42},
                {"start_seconds": 0.55, "end_seconds": 0.91},
            ],
        })
        self.assertEqual(result["timing_source"], "human_edited_syllable_windows")
        self.assertEqual(result["alignment"][0]["start_seconds"], 0.05)
        self.assertEqual(result["alignment"][0]["end_seconds"], 0.42)
        self.assertEqual(result["alignment"][1]["start_seconds"], 0.55)

    def test_align_endpoint_rejects_timing_outside_melody(self):
        with self.assertRaises(HTTPException) as error:
            align_job({
                "job": make_job(),
                "pronunciation_overrides": {"سلام": "سَ-لام"},
                "manual_note_groups": [[0], [1]],
                "manual_timing_windows": [
                    {"start_seconds": 0.0, "end_seconds": 0.5},
                    {"start_seconds": 0.5, "end_seconds": 9.0},
                ],
            })
        self.assertEqual(error.exception.status_code, 422)

    def test_prepare_conditioning_requires_explicit_phoneme_weights(self):
        from server import prepare_job_conditioning
        payload = {
            "job": make_job() | {"project": make_job()["project"] | {"lyrics": "سَم"}},
            "pronunciation_overrides": {"سَم": "سَم"},
            "manual_note_groups": [[0]],
            "manual_timing_windows": [{"start_seconds": 0.0, "end_seconds": 0.5}],
            "reviewed_phoneme_overrides": {"سَم": ["s", "æ", "m"]},
            "phoneme_duration_weights": [[1, 2, 1]],
        }
        result = prepare_job_conditioning(payload)
        self.assertEqual(result["conditioning"]["schema_version"], "mehran.svs.conditioning.v1")
        self.assertEqual([p["phoneme"] for p in result["conditioning"]["phonemes"]], ["s", "æ", "m"])
        self.assertFalse(result["accepted_for_inference"])
        self.assertFalse(result["audio_generated"])
        self.assertFalse(result["generation_ready"])

    def test_prepare_conditioning_rejects_missing_weights(self):
        from server import prepare_job_conditioning
        payload = {
            "job": make_job() | {"project": make_job()["project"] | {"lyrics": "سَم"}},
            "pronunciation_overrides": {"سَم": "سَم"},
            "manual_note_groups": [[0]],
            "manual_timing_windows": [{"start_seconds": 0.0, "end_seconds": 0.5}],
            "reviewed_phoneme_overrides": {"سَم": ["s", "æ", "m"]},
        }
        with self.assertRaises(HTTPException) as error:
            prepare_job_conditioning(payload)
        self.assertEqual(error.exception.status_code, 422)

    def test_align_endpoint_refuses_unreviewed_persian_pronunciation(self):
        result = align_job({
            "job": make_job(),
            "manual_note_groups": [[0], [1]],
        })
        self.assertFalse(result["alignment_ready"])
        self.assertEqual(result["unresolved_words"], ["سلام"])

    def test_align_endpoint_rejects_invalid_note_group(self):
        with self.assertRaises(HTTPException) as error:
            align_job({
                "job": make_job(),
                "pronunciation_overrides": {"سلام": "سَ-لام"},
                "manual_note_groups": [[0], [0]],
            })
        self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
