import math
import tempfile
import unittest
from pathlib import Path

from sample_bank import Sample, SampleBank
from velocity_layer_planner import plan_velocity_layers


def sample(low, high, note=60):
    return Sample(
        instrument="piano",
        midi_note=note,
        path=Path(f"/bank/piano/{low}-{high}.wav"),
        velocity_min=low,
        velocity_max=high,
        sample_rate=48000,
        channels=1,
        frames=48000,
        articulation="sustain",
    )


class VelocityLayerPlannerTests(unittest.TestCase):
    def setUp(self):
        self.bank = SampleBank(
            root=Path("/bank"),
            samples=(
                sample(1, 39),
                sample(24, 71),
                sample(56, 103),
                sample(88, 127),
            ),
        )

    def test_non_overlap_velocity_uses_one_recorded_layer(self):
        result = plan_velocity_layers(self.bank, "piano", 60, 12)
        self.assertEqual(result["selection_mode"], "single_recorded_layer")
        self.assertEqual(len(result["layers"]), 1)
        self.assertEqual(result["layers"][0]["sample"].velocity_min, 1)
        self.assertEqual(result["layers"][0]["gain"], 1.0)

    def test_overlap_velocity_uses_equal_power_blend(self):
        result = plan_velocity_layers(self.bank, "piano", 60, 31)
        self.assertEqual(result["selection_mode"], "equal_power_velocity_crossfade")
        self.assertEqual(result["overlap"], [24, 39])
        self.assertEqual(len(result["layers"]), 2)
        position = (31 - 24) / (39 - 24)
        self.assertAlmostEqual(result["layers"][0]["gain"], math.cos(position * math.pi / 2))
        self.assertAlmostEqual(result["layers"][1]["gain"], math.sin(position * math.pi / 2))
        self.assertAlmostEqual(
            sum(layer["gain"] ** 2 for layer in result["layers"]), 1.0
        )

    def test_all_three_overlap_zones_are_mapped(self):
        for velocity, expected in ((30, [24, 39]), (64, [56, 71]), (96, [88, 103])):
            result = plan_velocity_layers(self.bank, "piano", 60, velocity)
            self.assertEqual(result["overlap"], expected)
            self.assertEqual(len(result["layers"]), 2)

    def test_missing_exact_note_returns_no_layer_without_pitch_fallback(self):
        result = plan_velocity_layers(self.bank, "piano", 61, 80)
        self.assertEqual(result["selection_mode"], "no_exact_velocity_layer")
        self.assertEqual(result["layers"], [])

    def test_more_than_two_overlapping_layers_is_rejected(self):
        bank = SampleBank(
            root=Path("/bank"),
            samples=(sample(1, 100), sample(20, 110), sample(30, 120)),
        )
        with self.assertRaisesRegex(ValueError, "More than two"):
            plan_velocity_layers(bank, "piano", 60, 50)


if __name__ == "__main__":
    unittest.main()
