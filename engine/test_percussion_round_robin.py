"""Focused tests for recorded percussion one-shots and deterministic round robin."""
from __future__ import annotations

import json
import math
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank import load_sample_bank
from sample_renderer import build_composition_events, render_sample_events
from mehran_music_core import compose_plan


class PercussionRoundRobinTests(unittest.TestCase):
    def write_wav(self, path: Path, frames: int, frequency: int) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        rate = 22050
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            raw = b"".join(
                struct.pack("<h", int(7000 * math.sin(2 * math.pi * frequency * i / rate)
                                    * (1.0 - i / frames)))
                for i in range(frames)
            )
            wav.writeframes(raw)

    def test_one_shots_play_full_recording_and_rotate_round_robin(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_wav(root / "kick" / "take-1.wav", 2205, 70)
            self.write_wav(root / "kick" / "take-2.wav", 4410, 83)
            (root / "bank.json").write_text(json.dumps({
                "format_version": 1,
                "samples": [
                    {"instrument": "kick", "midi_note": 36,
                     "velocity_min": 1, "velocity_max": 127,
                     "articulation": "center", "round_robin_index": 0,
                     "one_shot": True, "path": "kick/take-1.wav"},
                    {"instrument": "kick", "midi_note": 36,
                     "velocity_min": 1, "velocity_max": 127,
                     "articulation": "center", "round_robin_index": 1,
                     "one_shot": True, "path": "kick/take-2.wav"},
                ],
            }), encoding="utf-8")
            bank = load_sample_bank(root)
            output = root / "two-kicks.wav"
            report = render_sample_events([
                {"instrument": "kick", "midi_note": 36, "start_seconds": 0.0,
                 "duration_seconds": 0.01, "velocity": 100, "articulation": "center"},
                {"instrument": "kick", "midi_note": 36, "start_seconds": 0.15,
                 "duration_seconds": 0.01, "velocity": 100, "articulation": "center"},
            ], bank, output, sample_rate=22050)

            self.assertEqual(report["events_rendered"], 2)
            self.assertEqual(report["sample_selection"]["one_shot_round_robin_events"], 2)
            with wave.open(str(output), "rb") as audio:
                self.assertAlmostEqual(audio.getnframes() / audio.getframerate(), 0.35, places=3)
                self.assertEqual(audio.getnchannels(), 2)
                self.assertTrue(any(audio.readframes(audio.getnframes())))

    def test_composition_maps_drum_parts_to_real_kit_articulations(self):
        plan = compose_plan("برگرد ای عشق\\nدلم گرفته از این شب سرد", target_bpm=84)
        events = build_composition_events(plan)
        expected = {
            "kick": "snares_on",
            "snare": "center",
            "closed_hat": "closed",
            "open_hat": "open",
        }
        for instrument, articulation in expected.items():
            matching = [event for event in events if event["instrument"] == instrument]
            self.assertTrue(matching, instrument)
            self.assertTrue(
                all(event["articulation"] == articulation for event in matching),
                instrument,
            )

    def test_one_shot_requires_exact_recorded_key_and_articulation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_wav(root / "snare.wav", 2205, 180)
            (root / "bank.json").write_text(json.dumps({
                "format_version": 1,
                "samples": [{
                    "instrument": "snare", "midi_note": 38,
                    "articulation": "center", "one_shot": True,
                    "path": "snare.wav",
                }],
            }), encoding="utf-8")
            bank = load_sample_bank(root)
            with self.assertRaisesRegex(ValueError, "exact recorded key"):
                render_sample_events([{
                    "instrument": "snare", "midi_note": 40,
                    "start_seconds": 0, "duration_seconds": 0.1,
                    "articulation": "center",
                }], bank, root / "wrong-key.wav")

    def test_one_shot_manifest_rejects_sustain_loop(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.write_wav(root / "hat.wav", 2205, 900)
            (root / "bank.json").write_text(json.dumps({
                "format_version": 1,
                "samples": [{
                    "instrument": "closed_hat", "midi_note": 42,
                    "one_shot": True, "loop_start_frame": 10,
                    "loop_end_frame": 100, "path": "hat.wav",
                }],
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "cannot define sustain loops"):
                load_sample_bank(root)


if __name__ == "__main__":
    unittest.main()
