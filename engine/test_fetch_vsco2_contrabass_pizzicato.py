import unittest

from fetch_vsco2_contrabass_pizzicato import parse_vsco2_contrabass_pizz_sfz


def fixture():
    groups = []
    for (low, high), rr in zip(((0.0, 0.5), (0.5, 1.0)), (1, 2)):
        lines = [
            "<group>", f"lorand={low}", f"hirand={high}",
            "<region>",
            f"sample=BKCtbss_Pizz_A#0_v3_rr{rr}.wav",
            "lokey=33",
            "hikey=34",
            "pitch_keycenter=34",
            "lovel=63",
            "hivel=127",
            "volume=5",
        ]
        groups.append("\n".join(lines))
    return "\n".join(groups)


class VSCO2ContrabassPizzTests(unittest.TestCase):
    def test_extracts_exact_midi34_high_layer_and_two_round_robins(self):
        samples = parse_vsco2_contrabass_pizz_sfz(fixture())
        self.assertEqual(len(samples), 2)
        self.assertEqual({x["midi_note"] for x in samples}, {34})
        self.assertEqual({(x["velocity_min"], x["velocity_max"]) for x in samples}, {(63, 127)})
        self.assertEqual({x["round_robin_index"] for x in samples}, {0, 1})
        self.assertEqual({(x["low_key"], x["high_key"]) for x in samples}, {(33, 34)})
        self.assertEqual({x["sfz_volume_db"] for x in samples}, {5.0})

    def test_rejects_velocity_mapping_drift(self):
        text = fixture().replace("lovel=63", "lovel=62", 1)
        with self.assertRaisesRegex(ValueError, "Unexpected VSCO 2 CE MIDI 34 SFZ mapping"):
            parse_vsco2_contrabass_pizz_sfz(text)

    def test_requires_both_random_group_references_for_each_take(self):
        text = fixture().split("<group>")[0] + "<group>" + fixture().split("<group>")[1]
        with self.assertRaisesRegex(ValueError, "Expected only the two MIDI 34 high-layer samples"):
            parse_vsco2_contrabass_pizz_sfz(text)

    def test_rejects_non_exact_pitch_center(self):
        text = fixture().replace("pitch_keycenter=34", "pitch_keycenter=33", 1)
        with self.assertRaisesRegex(ValueError, "Unexpected VSCO 2 CE MIDI 34 SFZ mapping"):
            parse_vsco2_contrabass_pizz_sfz(text)


if __name__ == "__main__":
    unittest.main()
