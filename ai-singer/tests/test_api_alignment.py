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
