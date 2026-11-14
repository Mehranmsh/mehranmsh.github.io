from __future__ import annotations

import hashlib
import tempfile
import unittest
import wave
from pathlib import Path

from synthesis_runtime import verify_synthesis_output


class SynthesisOutputContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.audio = self.root / "vocal.wav"
        with wave.open(str(self.audio), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(48000)
            wav.writeframes(bytes([0, 0]) * 4800)
        self.payload = {
            "schema_version": "mehran.svs.output.v1",
            "project_id": "project-fa-01",
            "artifact_path": "vocal.wav",
            "format": "wav",
            "codec": "pcm_s16le",
            "sample_rate": 48000,
            "channels": 1,
            "duration_seconds": 0.1,
            "frames": 4800,
            "sha256": hashlib.sha256(self.audio.read_bytes()).hexdigest(),
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_valid_pcm_wav_output(self):
        result = verify_synthesis_output(
            self.payload, output_directory=self.root, expected_project_id="project-fa-01"
        )
        self.assertTrue(result["valid"])
        self.assertEqual(result["duration_seconds"], 0.1)
        self.assertTrue(result["audio_generated"])

    def test_project_mismatch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "project_id"):
            verify_synthesis_output(
                self.payload, output_directory=self.root, expected_project_id="another-project"
            )

    def test_path_traversal_is_rejected(self):
        self.payload["artifact_path"] = "../vocal.wav"
        with self.assertRaisesRegex(ValueError, "unsafe"):
            verify_synthesis_output(
                self.payload, output_directory=self.root, expected_project_id="project-fa-01"
            )

    def test_hash_mismatch_is_rejected(self):
        self.payload["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            verify_synthesis_output(
                self.payload, output_directory=self.root, expected_project_id="project-fa-01"
            )

    def test_declared_frame_count_mismatch_is_rejected(self):
        self.payload["frames"] = 100
        with self.assertRaisesRegex(ValueError, "frame count"):
            verify_synthesis_output(
                self.payload, output_directory=self.root, expected_project_id="project-fa-01"
            )

    def test_stereo_output_is_rejected(self):
        self.payload["channels"] = 2
        with self.assertRaises(Exception):
            verify_synthesis_output(
                self.payload, output_directory=self.root, expected_project_id="project-fa-01"
            )


if __name__ == "__main__":
    unittest.main()
