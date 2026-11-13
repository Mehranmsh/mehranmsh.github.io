import unittest

from fetch_vsco2_cello_section import MAPS, parse_cello_section_maps


ROOTS = [36, 40, 43, 47, 50, 53, 57, 60, 64, 67, 71, 74, 77]
NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def pitch(root):
    return f"{NAMES[root % 12]}{root // 12 - 2}"


def region(filename, root, low, high, volume=0):
    return ["<region>", f"sample={filename}", f"pitch_keycenter={root}",
            f"lokey={root}", f"hikey={root}", f"lovel={low}",
            f"hivel={high}", f"volume={volume}"]


def fixture_map(key):
    folder = {
        "pizzicato": "pizzT", "spiccato": "spic",
        "sustain_quiet": "susvib", "sustain_vibrato": "susvib",
        "tremolo": "trem",
    }[key]
    lines = ["<control>", f"default_path=Strings\\Cello Section\\{folder}\\", "<global>"]
    if key in ("pizzicato", "spiccato"):
        prefix = folder
        for rr in (1, 2):
            lines.extend(["<group>", "seq_length=2", f"seq_position={rr}"])
            for root in ROOTS:
                for layer, low, high in ((1, 0, 62), (2, 63, 127)):
                    lines.extend(region(f"{prefix}_{pitch(root)}_v{layer}_RR{rr}.wav", root, low, high))
    elif key in ("sustain_quiet", "sustain_vibrato"):
        lines.append("<group>")
        for root in ROOTS:
            if root == 40:
                lines.extend(region("susvib_E1_v1_1.wav", root, 0, 41, 16))
                lines.extend(region("susvib_E1_v1_2.wav", root, 42, 127 if key == "sustain_quiet" else 62, 16))
            else:
                low_high = 127 if key == "sustain_quiet" else 62
                lines.extend(region(f"susvib_{pitch(root)}_v1_1.wav", root, 0, low_high, 16))
        if key == "sustain_vibrato":
            for root in ROOTS:
                lines.extend(region(f"susvib_{pitch(root)}_v3_1.wav", root, 63, 127, 4))
    else:
        lines.append("<group>")
        low_roots = [57, 47, 71, 60, 50, 74, 40, 64, 53, 77, 43, 67]
        high_roots = [57, 59, 71, 36, 60, 50, 74, 40, 64, 53, 77, 43, 67]
        for root in low_roots:
            lines.extend(region(f"trem_{pitch(root)}_v1_1.wav", root, 0, 127 if root == 47 else 62, 26))
        for root in high_roots:
            lines.extend(region(f"trem_{pitch(root)}_v2_1.wav", root, 0 if root == 59 or root == 36 else 63, 127, 4))
    return "\n".join(lines)


class CelloSectionMapTests(unittest.TestCase):
    def test_requires_all_five_maps_and_expected_region_shape(self):
        maps = {key: fixture_map(key) for key in MAPS}
        result = parse_cello_section_maps(maps)
        self.assertEqual(len(result), 170)
        self.assertEqual(len({x["source_path"] for x in result}), 156)
        self.assertEqual({x["articulation"] for x in result}, {
            "pizzicato", "spiccato", "sustain_vibrato_quiet",
            "sustain_vibrato", "tremolo",
        })

    def test_requires_every_map(self):
        with self.assertRaisesRegex(ValueError, "five official"):
            parse_cello_section_maps({key: fixture_map(key) for key in list(MAPS)[:-1]})

    def test_rejects_sequence_metadata_on_non_rr_articulation(self):
        maps = {key: fixture_map(key) for key in MAPS}
        maps["sustain_quiet"] = maps["sustain_quiet"].replace("<group>", "<group>\nseq_length=2", 1)
        with self.assertRaisesRegex(ValueError, "sequence metadata"):
            parse_cello_section_maps(maps)

    def test_rejects_a_mismatched_filename_root(self):
        maps = {key: fixture_map(key) for key in MAPS}
        maps["pizzicato"] = maps["pizzicato"].replace("pitch_keycenter=57\nlokey=57\nhikey=57", "pitch_keycenter=58\nlokey=58\nhikey=58", 1)
        with self.assertRaisesRegex(ValueError, "root does not match"):
            parse_cello_section_maps(maps)


if __name__ == "__main__":
    unittest.main()