import unittest

from arrangement_planner import plan_part_arrangement


class ArrangementPlannerTests(unittest.TestCase):
    def test_density_builds_from_verse_to_final_chorus(self):
        verse = plan_part_arrangement("chords", "verse")
        pre = plan_part_arrangement("chords", "pre_chorus")
        chorus = plan_part_arrangement("chords", "chorus")
        final = plan_part_arrangement("chords", "final_chorus")
        self.assertLess(verse["gain"], pre["gain"])
        self.assertLess(pre["gain"], chorus["gain"])
        self.assertLess(chorus["gain"], final["gain"])

    def test_bridge_reduces_supporting_parts_but_keeps_melody(self):
        bridge = plan_part_arrangement("chords", "bridge")
        verse = plan_part_arrangement("chords", "verse")
        self.assertTrue(plan_part_arrangement("melody", "bridge")["active"])
        self.assertLess(bridge["gain"], verse["gain"])
        self.assertEqual(bridge["density"], "sparse")

    def test_optional_layers_enter_only_in_full_sections(self):
        for part in ("strings", "electric_guitar", "open_hat"):
            self.assertFalse(plan_part_arrangement(part, "verse")["active"])
            self.assertFalse(plan_part_arrangement(part, "bridge")["active"])
            self.assertTrue(plan_part_arrangement(part, "chorus")["active"])
            self.assertTrue(plan_part_arrangement(part, "final_chorus")["active"])

    def test_rhythm_anchor_remains_active_in_every_section(self):
        for section in ("verse", "pre_chorus", "chorus", "bridge", "final_chorus"):
            self.assertTrue(plan_part_arrangement("kick", section)["active"])

    def test_invalid_inputs_are_rejected(self):
        for args in (("unknown", "verse"), ("melody", "intro"),
                     ("melody", "verse", -1), ("melody", "verse", True)):
            with self.assertRaises(ValueError):
                plan_part_arrangement(*args)


if __name__ == "__main__":
    unittest.main()
