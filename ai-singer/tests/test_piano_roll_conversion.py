import unittest
from types import SimpleNamespace

from server import piano_roll_to_melody


class PianoRollConversionTests(unittest.TestCase):
    def test_sorts_notes_and_converts_steps_to_seconds(self):
        events = [
            SimpleNamespace(note="G4", startStep=4, lengthSteps=2, velocity=90),
            SimpleNamespace(note="C4", startStep=0, lengthSteps=4, velocity=80),
        ]
        result = piano_roll_to_melody(events, 120)
        self.assertEqual([note["note"] for note in result["notes"]], ["C4", "G4"])
        self.assertEqual(result["notes"][0]["startSeconds"], 0.0)
        self.assertEqual(result["notes"][0]["durationSeconds"], 0.5)
        self.assertEqual(result["notes"][1]["startSeconds"], 0.5)
        self.assertEqual(result["durationSeconds"], 0.75)

    def test_rejects_invalid_tempo(self):
        with self.assertRaises(ValueError):
            piano_roll_to_melody([], 0)


if __name__ == "__main__":
    unittest.main()
