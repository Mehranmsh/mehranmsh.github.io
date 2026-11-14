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

    def test_nylon_guitar_has_its_own_fingerpicked_arrangement_role(self):
        self.assertEqual(plan_part_arrangement("nylon_guitar", "verse")["role"], "fingerpicked_harmony")
        self.assertTrue(plan_part_arrangement("nylon_guitar", "verse")["active"])
        self.assertGreater(plan_part_arrangement("nylon_guitar", "final_chorus")["gain"],
                           plan_part_arrangement("nylon_guitar", "verse")["gain"])

    def test_harp_and_cello_have_distinct_section_entries(self):
        self.assertTrue(plan_part_arrangement("harp", "verse")["active"])
        self.assertFalse(plan_part_arrangement("cello", "verse")["active"])
        self.assertTrue(plan_part_arrangement("harp", "chorus")["active"])
        self.assertTrue(plan_part_arrangement("cello", "chorus")["active"])
        self.assertTrue(plan_part_arrangement("cello", "bridge")["active"])

    def test_recorder_and_dan_tranh_have_independent_section_entries(self):
        for part in ("recorder", "dan_tranh"):
            self.assertTrue(plan_part_arrangement(part, "verse")["active"])
            self.assertTrue(plan_part_arrangement(part, "pre_chorus")["active"])
            self.assertTrue(plan_part_arrangement(part, "chorus")["active"])
            self.assertTrue(plan_part_arrangement(part, "bridge")["active"])
            self.assertTrue(plan_part_arrangement(part, "final_chorus")["active"])

    def test_flute_enters_in_building_and_full_sections_only(self):
        self.assertFalse(plan_part_arrangement("flute", "verse")["active"])
        self.assertTrue(plan_part_arrangement("flute", "pre_chorus")["active"])
        self.assertTrue(plan_part_arrangement("flute", "chorus")["active"])
        self.assertTrue(plan_part_arrangement("flute", "bridge")["active"])
        self.assertTrue(plan_part_arrangement("flute", "final_chorus")["active"])

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
