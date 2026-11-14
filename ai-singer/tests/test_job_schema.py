import base64
import unittest

from pydantic import ValidationError

from job_schema import SingingJob


def valid_job():
    midi = b"MThd" + b"\x00\x00\x00\x06" + b"\x00\x01\x00\x01\x00\x60"
    return {
        "schema": "mehran.svs.job.v1",
        "project": {"id": "test-project", "name": "Test", "language": "Persian", "tempo": 92, "lyrics": "سلام دنیا"},
        "singer": {"name": "Lead Vocal", "language": "Persian", "role": "Lead"},
        "melody": {
            "source": "midi_file",
            "midi": {
                "fileName": "melody.mid",
                "mimeType": "audio/midi",
                "size": len(midi),
                "encoding": "base64",
                "data": base64.b64encode(midi).decode("ascii"),
            },
            "noteEvents": [],
            "chords": [],
        },
        "render": {"format": "wav", "sampleRate": 48000, "output": "isolated_vocal_stem"},
        "engine": {"provider": "MEHRAN", "deployment": "self-hosted", "modelId": "mehran-svs-native", "thirdPartyGenerationApi": False},
    }


class SingingJobTests(unittest.TestCase):
    def test_valid_persian_midi_job(self):
        job = SingingJob.model_validate(valid_job())
        self.assertEqual(job.project.lyrics, "سلام دنیا")
        self.assertEqual(job.melody.source, "midi_file")

    def test_rejects_invalid_midi_header(self):
        payload = valid_job()
        payload["melody"]["midi"]["data"] = base64.b64encode(b"not a midi file!").decode("ascii")
        payload["melody"]["midi"]["size"] = len(b"not a midi file!")
        with self.assertRaises(ValidationError):
            SingingJob.model_validate(payload)

    def test_rejects_missing_melody(self):
        payload = valid_job()
        payload["melody"] = {"source": "not_provided", "midi": None, "noteEvents": [], "chords": []}
        with self.assertRaises(ValidationError):
            SingingJob.model_validate(payload)


if __name__ == "__main__":
    unittest.main()
