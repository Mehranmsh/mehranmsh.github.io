import unittest

from dynamics_planner import plan_dynamics


class DynamicsPlannerTests(unittest.TestCase):
    def test_crescendo_rises_deterministically(self):
        events = plan_dynamics([{} for _ in range(5)], "crescendo")["events"]
        values = [item["dynamics_velocity"] for item in events]
        self.assertEqual(values, sorted(values))
        self.assertLess(values[0], values[-1])

    def test_decrescendo_falls_deterministically(self):
        events = plan_dynamics([{} for _ in range(5)], "decrescendo")["events"]
        values = [item["dynamics_velocity"] for item in events]
        self.assertEqual(values, sorted(values, reverse=True))
        self.assertGreater(values[0], values[-1])

    def test_arch_curve_peaks_in_the_middle(self):
        events = plan_dynamics([{} for _ in range(5)], "arch")["events"]
        values = [item["dynamics_velocity"] for item in events]
        self.assertEqual(max(values), values[2])
        self.assertEqual(values[0], values[-1])

    def test_natural_curve_reinforces_the_declared_melodic_peak(self):
        events = plan_dynamics([{}, {"is_melodic_peak": True}, {}], "natural")["events"]
        values = [item["dynamics_velocity"] for item in events]
        self.assertEqual(values[1], max(values))

    def test_curated_lexical_stress_adds_a_controlled_accent(self):
        plain = plan_dynamics([{}], "steady")["events"][0]["dynamics_velocity"]
        stressed = plan_dynamics([{"is_lexically_stressed": True,
                                   "stress_confidence": "curated"}],
                                 "steady")["events"][0]["dynamics_velocity"]
        self.assertEqual(stressed, plain + 6)

    def test_explicit_velocity_is_preserved(self):
        item = plan_dynamics([{"dynamics_velocity": 101}], "steady")["events"][0]
        self.assertEqual(item["dynamics_velocity"], 101)
        self.assertEqual(item["dynamics_reason"], "explicit_velocity_preserved")

    def test_invalid_curve_and_velocity_are_rejected(self):
        with self.assertRaises(ValueError):
            plan_dynamics([{}], "random")
        with self.assertRaises(ValueError):
            plan_dynamics([{"dynamics_velocity": 128}], "steady")


if __name__ == "__main__":
    unittest.main()
