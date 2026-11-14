import unittest

from fetch_vsco2_violin_spiccato import EXPECTED_ROOTS, parse_spiccato_mapping


def mapping_fixture():
    lines = []
    for rr in (1, 2):
        lines.extend(["<group>", "seq_length=2", f"seq_position={rr}"])
        for note in EXPECTED_ROOTS:
            octave = note // 12 - 2
            pitch_class = note % 12
            names = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
            pitch = f"{names[pitch_class]}{octave}"
            for layer, low, high, volume in ((1, 0, 62, 20), (2, 63, 127, 7)):
                lines.extend([
                    "<region>",
                    f"sample=LLVln_spic_{pitch}_v{layer}_rr{rr}.wav",
                    f"pitch_keycenter={note}",
                    f"lokey={note}",
                    f"hikey={note}",
                    f"lovel={low}",
                    f"hivel={high}",
                    f"volume={volume}",
                ])
    return "\n".join(lines)


class SpiccatoMappingTests(unittest.TestCase):
    def test_full_official_shape_has_60_samples_and_complete_layers(self):
        items = parse_spiccato_mapping(mapping_fixture())
        self.assertEqual(len(items), 60)
        self.assertEqual(tuple(sorted({x["midi_note"] for x in items})), EXPECTED_ROOTS)
        self.assertEqual({x["velocity_min"] for x in items}, {1, 63})
        self.assertEqual({x["velocity_max"] for x in items}, {62, 127})
        self.assertEqual({x["round_robin_index"] for x in items}, {0, 1})

    def test_preserves_source_key_zones_and_sfz_gain(self):
        items = parse_spiccato_mapping(mapping_fixture())
        low = next(x for x in items if x["midi_note"] == 57 and x["velocity_min"] == 1)
        high = next(x for x in items if x["midi_note"] == 57 and x["velocity_min"] == 63)
        self.assertEqual((low["playable_key_min"], low["playable_key_max"]), (57, 57))
        self.assertEqual(low["sfz_volume_db"], 20.0)
        self.assertEqual(high["sfz_volume_db"], 7.0)

    def test_rejects_sequence_filename_mismatch(self):
        source = mapping_fixture().replace("seq_position=1", "seq_position=2", 1)
        with self.assertRaisesRegex(ValueError, "sequence positions"):
            parse_spiccato_mapping(source)

    def test_rejects_missing_round_robin_sample(self):
        source = mapping_fixture().replace(
            "sample=LLVln_spic_A2_v1_rr1.wav\n", "", 1
        )
        with self.assertRaises(ValueError):
            parse_spiccato_mapping(source)


if __name__ == "__main__":
    unittest.main()
