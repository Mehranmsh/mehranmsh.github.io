import tempfile
import unittest
from pathlib import Path

from sample_bank import Sample, SampleBank
from guitar_string_planner import plan_guitar_string, string_for_sample


def sample(string_name, note, velocity_min=1, velocity_max=127):
    path = Path(f"INSGuitarSteel_String{string_name}_Vel01_C4_01.wav")
    return Sample(
        instrument="acoustic_guitar", midi_note=note, path=path,
        velocity_min=velocity_min, velocity_max=velocity_max,
        sample_rate=48000, channels=1, frames=1000,
        articulation="sustain",
    )


class GuitarStringPlannerTests(unittest.TestCase):
    def setUp(self):
        self.bank = SampleBank(Path(tempfile.gettempdir()), (
            sample("LowE", 60), sample("A", 60), sample("D", 60),
            sample("G", 60), sample("B", 60), sample("HighE", 64),
        ))

    def test_auto_prefers_lowest_string_in_first_position(self):
        result = plan_guitar_string(self.bank, "acoustic_guitar", 60, 64)
        self.assertEqual(result["selected_string"], "B")
        self.assertEqual(result["fret"], 1)
        self.assertEqual(result["status"], "exact_recorded_string")

    def test_auto_uses_first_available_low_string_within_four_frets(self):
        bank = SampleBank(self.bank.root, (sample("LowE", 43), sample("A", 48)))
        result = plan_guitar_string(bank, "acoustic_guitar", 48, 70)
        self.assertEqual(result["selected_string"], "A")
        self.assertEqual(result["fret"], 3)

    def test_explicit_string_is_respected(self):
        result = plan_guitar_string(
            self.bank, "acoustic_guitar", 60, 64, preferred_string="LowE", max_fret=24
        )
        self.assertEqual(result["selected_string"], "LowE")
        self.assertEqual(result["fret"], 20)

    def test_missing_first_position_does_not_silently_choose_high_fret(self):
        bank = SampleBank(self.bank.root, (sample("LowE", 60),))
        result = plan_guitar_string(bank, "acoustic_guitar", 60, 64)
        self.assertEqual(result["status"], "no_first_position_match")
        self.assertIsNone(result["selected_string"])
        self.assertEqual(result["available_strings"], ["LowE"])

    def test_string_identity_parser_handles_nylon_technique_suffix(self):
        nylon = Sample(
            instrument="nylon_guitar", midi_note=45,
            path=Path("INSGuitarNylon_StringA_Vel01Finger_A2_01.wav"),
            velocity_min=1, velocity_max=127, sample_rate=48000,
            channels=1, frames=1000, articulation="sustain",
        )
        self.assertEqual(string_for_sample(nylon), "A")

    def test_nylon_fingerpicked_part_selects_exact_recorded_string_and_fret(self):
        nylon_samples = (
            Sample(
                instrument="nylon_guitar", midi_note=45,
                path=Path("INSGuitarNylon_StringA_Vel01Finger_A2_01.wav"),
                velocity_min=1, velocity_max=127, sample_rate=48000,
                channels=1, frames=1000, articulation="finger",
            ),
            Sample(
                instrument="nylon_guitar", midi_note=45,
                path=Path("INSGuitarNylon_StringLowE_Vel01Finger_A2_01.wav"),
                velocity_min=1, velocity_max=127, sample_rate=48000,
                channels=1, frames=1000, articulation="finger",
            ),
        )
        bank = SampleBank(Path(tempfile.gettempdir()), nylon_samples)
        result = plan_guitar_string(
            bank, "nylon_guitar", 45, 72, articulation="finger"
        )
        self.assertEqual(result["status"], "exact_recorded_string")
        self.assertEqual(result["selected_string"], "A")
        self.assertEqual(result["fret"], 0)
        self.assertEqual(result["layers"][0]["sample"].articulation, "finger")

    def test_nylon_fingerpicked_selection_never_uses_unrecorded_string(self):
        nylon = Sample(
            instrument="nylon_guitar", midi_note=45,
            path=Path("INSGuitarNylon_StringA_Vel01Finger_A2_01.wav"),
            velocity_min=1, velocity_max=127, sample_rate=48000,
            channels=1, frames=1000, articulation="finger",
        )
        result = plan_guitar_string(
            SampleBank(Path(tempfile.gettempdir()), (nylon,)),
            "nylon_guitar", 45, 72, articulation="finger",
            preferred_string="LowE",
        )
        self.assertEqual(result["status"], "no_first_position_match")
        self.assertIsNone(result["selected_string"])

    def test_invalid_string_is_rejected(self):
        with self.assertRaises(ValueError):
            plan_guitar_string(self.bank, "acoustic_guitar", 60, 64, preferred_string="E")

    def test_invalid_fret_limit_is_rejected(self):
        with self.assertRaises(ValueError):
            plan_guitar_string(self.bank, "acoustic_guitar", 60, 64, max_fret=25)


if __name__ == "__main__":
    unittest.main()
