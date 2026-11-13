import unittest

from fetch_karoryfer_meatbass import EXPECTED_NOTES, parse_meatbass_pizz_sfz


NOTE_NAMES = ["a0", "c1", "eb1", "gb1", "a1", "c2", "eb2", "gb2",
              "a2", "c3", "eb3", "gb3", "a3", "c4"]


def fixture(missing=None):
    lines = []
    for note_name, midi in zip(NOTE_NAMES, EXPECTED_NOTES):
        low, high = (12, 22) if midi == 21 else (midi - 1, midi + 1)
        for layer, (vmin, vmax) in enumerate(((1, 32), (33, 64), (65, 96), (97, 127)), 1):
            lines.extend([
                "<group>", f"lokey={low}", f"hikey={high}",
                f"lovel={vmin}" if vmin > 1 else "hivel=32",
                f"hivel={vmax}" if vmin > 1 else "",
                f"pitch_keycenter={midi}",
            ])
            for rr in range(1, 5):
                name = f"{note_name}_vl{layer}_rr{rr}.wav"
                if name != missing:
                    lines.extend(["<region>", f"sample=..\\Samples\\pizz\\{name}"])
    return "\n".join(lines)


class MeatbassPizzTests(unittest.TestCase):
    def test_parses_four_velocity_layers_and_four_round_robins(self):
        samples = parse_meatbass_pizz_sfz(fixture(), require_complete=True)
        self.assertEqual(len(samples), 224)
        self.assertEqual({(x["velocity_min"], x["velocity_max"]) for x in samples},
                         {(1, 32), (33, 64), (65, 96), (97, 127)})
        self.assertEqual({x["round_robin_index"] for x in samples}, {0, 1, 2, 3})

    def test_rejects_wrong_velocity_map(self):
        text = fixture().replace("lovel=33", "lovel=34", 1)
        with self.assertRaisesRegex(ValueError, "Unexpected velocity mapping"):
            parse_meatbass_pizz_sfz(text, require_complete=False)

    def test_requires_all_four_round_robin_takes(self):
        text = fixture(missing="a0_vl4_rr4.wav")
        with self.assertRaisesRegex(ValueError, "Expected 224 mapped"):
            parse_meatbass_pizz_sfz(text, require_complete=True)


if __name__ == "__main__":
    unittest.main()
