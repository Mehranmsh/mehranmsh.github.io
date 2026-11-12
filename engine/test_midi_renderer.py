import tempfile
import unittest
from pathlib import Path

from mehran_music_core import compose_plan
from midi_renderer import render_midi


class MidiRendererTests(unittest.TestCase):
    def test_renders_five_track_standard_midi_with_rhythm_section(self):
        plan = compose_plan("دلم گرفته\nاز این شب سرد\nبرگرد ای عشق\nبه خانه برگرد",
                            title="برگرد", target_bpm=84)
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "song.mid"
            result = render_midi(plan, target)
            data = target.read_bytes()
        self.assertEqual(data[:4], b"MThd")
        self.assertEqual(int.from_bytes(data[10:12], "big"), 5)
        self.assertEqual(result["tracks"], 5)
        self.assertGreater(result["note_events"], 0)
        self.assertGreater(result["bass_note_events"], 0)
        self.assertGreater(result["drum_hits"], 0)
        self.assertEqual(result["drum_channel"], 10)
        self.assertGreater(len(data), 40)
        self.assertGreater(result["duration_seconds"], 0)

    def test_long_lyric_line_gets_more_than_one_bar(self):
        plan = compose_plan("این یک مصرع بسیار بلند است که باید زمان بیشتری بگیرد")
        phrase = plan["composition"]["melody"][0]
        self.assertGreaterEqual(phrase["bar_count"], 2)
        self.assertEqual(sum(phrase["note_durations_ticks"]), phrase["duration_ticks"])

    def test_chord_voicings_use_close_voice_leading(self):
        plan = compose_plan("دلم گرفته\nاز این شب سرد\nبرگرد ای عشق\nبه خانه برگرد")
        with tempfile.TemporaryDirectory() as folder:
            result = render_midi(plan, Path(folder) / "song.mid")
        voicings = result["chord_voicings"]
        self.assertGreaterEqual(len(voicings), 4)
        for voicing in voicings:
            notes = voicing["midi_notes"]
            self.assertEqual(len(notes), 3)
            self.assertEqual(notes, sorted(notes))
            self.assertLessEqual(notes[-1] - notes[0], 19)

    def test_flat_chord_is_supported(self):
        plan = compose_plan("فریاد\nخشم\nآتش\nجنگ")
        with tempfile.TemporaryDirectory() as folder:
            result = render_midi(plan, Path(folder) / "song.mid")
        self.assertTrue(any(item["symbol"] == "Bb" for item in result["chord_voicings"]))

    def test_rejects_malformed_plan(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                render_midi({}, Path(folder) / "bad.mid")

    def test_rejects_out_of_range_notes(self):
        plan = compose_plan("یک شعر")
        plan["composition"]["melody"][0]["midi_notes"] = [120]
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                render_midi(plan, Path(folder) / "bad.mid")

    def test_rejects_duration_mismatch(self):
        plan = compose_plan("یک شعر کوتاه")
        plan["composition"]["melody"][0]["note_durations_ticks"] = [1]
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                render_midi(plan, Path(folder) / "bad.mid")


if __name__ == "__main__":
    unittest.main()
