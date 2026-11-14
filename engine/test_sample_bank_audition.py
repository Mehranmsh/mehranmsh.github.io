import json
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank_audition import build_velocity_sweep_events, render_velocity_sweep


class SampleBankAuditionTests(unittest.TestCase):
    def make_wav(self, path):
        import math
        import struct
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(22050)
            wav.writeframes(b"".join(
                struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 22050)))
                for i in range(2205)
            ))

    def make_bank(self, root):
        layers = ((1, 39), (24, 71), (56, 103), (88, 127))
        samples = []
        for low, high in layers:
            relative = f"piano/c4-{low}-{high}.wav"
            self.make_wav(root / relative)
            samples.append({
                "instrument": "piano", "midi_note": 60,
                "velocity_min": low, "velocity_max": high,
                "articulation": "sustain", "path": relative,
            })
        (root / "bank.json").write_text(json.dumps({
            "format_version": 1, "samples": samples,
        }), encoding="utf-8")

    def test_builds_sequential_exact_velocity_events(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            self.make_bank(root)
            bank, events = build_velocity_sweep_events(
                root, "piano", 60, [16, 31, 64, 96], note_duration=0.5, gap_seconds=0.1
            )
            self.assertEqual(len(bank.samples), 4)
            self.assertEqual([e["velocity"] for e in events], [16, 31, 64, 96])
            self.assertEqual([e["start_seconds"] for e in events], [0.0, 0.6, 1.2, 1.8])
            self.assertEqual(events[1]["velocity_selection_mode"], "equal_power_velocity_crossfade")

    def test_renders_non_silent_velocity_sweep_from_recordings(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            self.make_bank(root)
            output = Path(folder) / "velocity-sweep.wav"
            result = render_velocity_sweep(
                root, "piano", 60, [16, 31, 64, 96], output, sample_rate=22050,
                note_duration=0.05, gap_seconds=0.01,
            )
            self.assertTrue(result["rendered"])
            self.assertEqual(result["render_metadata"]["events_rendered"], 4)
            with wave.open(str(output), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 2)
                self.assertTrue(any(wav.readframes(wav.getnframes())))

    def test_missing_exact_articulation_is_blocked(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            self.make_bank(root)
            with self.assertRaisesRegex(ValueError, "Exact recorded velocity layer unavailable"):
                build_velocity_sweep_events(
                    root, "piano", 60, [64], articulation="staccato"
                )

    def test_rejects_duplicate_or_invalid_velocity_values(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bank"
            root.mkdir()
            self.make_bank(root)
            with self.assertRaises(ValueError):
                build_velocity_sweep_events(root, "piano", 60, [31, 31])
            with self.assertRaises(ValueError):
                build_velocity_sweep_events(root, "piano", 60, [0])


if __name__ == "__main__":
    unittest.main()
