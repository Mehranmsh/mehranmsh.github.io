from __future__ import annotations

import json
import tempfile
import unittest
import wave
from pathlib import Path

import listening_review


class FixedChoice:
    def __init__(self, choices):
        self.choices = iter(choices)

    def choice(self, _values):
        return next(self.choices)


def write_wav(path: Path, value: int = 1000):
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(48000)
        wav.writeframes(value.to_bytes(2, "little", signed=True) * 256)


class ListeningReviewTests(unittest.TestCase):
    def test_creates_blind_offline_package_and_private_key(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "audio"
            root.mkdir()
            write_wav(root / "base.wav", 1000)
            write_wav(root / "candidate.wav", 2000)
            output = Path(temp) / "review"
            result = listening_review.build_listening_review(
                [{"item_id": "private-recording-7", "baseline_wav": "base.wav", "candidate_wav": "candidate.wav"}],
                root, output, rng=FixedChoice(["A"]),
            )
            html = (output / "review.html").read_text(encoding="utf-8")
            key = json.loads((output / "PRIVATE-answer-key.json").read_text(encoding="utf-8"))
            self.assertIn("Version A", html)
            self.assertIn("Version B", html)
            self.assertNotIn("private-recording-7", html)
            self.assertNotIn("baseline", html)
            self.assertEqual(key["pairs"][0]["A"], "baseline")
            self.assertEqual(result["audio_uploaded"], False)
            self.assertEqual(len(list((output / "media").glob("*.wav"))), 2)

    def test_rejects_existing_output_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "audio"
            root.mkdir()
            write_wav(root / "a.wav")
            output = Path(temp) / "review"
            output.mkdir()
            pair = [{"item_id": "x", "baseline_wav": "a.wav", "candidate_wav": "a.wav"}]
            with self.assertRaisesRegex(listening_review.ListeningReviewError, "must not already exist"):
                listening_review.build_listening_review(pair, root, output)

    def test_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "audio"
            root.mkdir()
            write_wav(Path(temp) / "outside.wav")
            pair = [{"item_id": "x", "baseline_wav": "../outside.wav", "candidate_wav": "../outside.wav"}]
            with self.assertRaisesRegex(listening_review.ListeningReviewError, "unsafe"):
                listening_review.build_listening_review(pair, root, Path(temp) / "review")

    def test_rejects_stereo_audio(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "audio"
            root.mkdir()
            with wave.open(str(root / "stereo.wav"), "wb") as wav:
                wav.setnchannels(2)
                wav.setsampwidth(2)
                wav.setframerate(48000)
                wav.writeframes(b"\\x00\\x00" * 512)
            pair = [{"item_id": "x", "baseline_wav": "stereo.wav", "candidate_wav": "stereo.wav"}]
            with self.assertRaisesRegex(listening_review.ListeningReviewError, "mono PCM"):
                listening_review.build_listening_review(pair, root, Path(temp) / "review")

    def test_rejects_too_many_pairs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "audio"
            root.mkdir()
            pairs = [{"item_id": "x", "baseline_wav": "a.wav", "candidate_wav": "b.wav"}] * 501
            with self.assertRaisesRegex(listening_review.ListeningReviewError, "between 1 and 500"):
                listening_review.build_listening_review(pairs, root, Path(temp) / "review")


if __name__ == "__main__":
    unittest.main()
