import unittest

from fetch_vsco2_cello_section import MAPS, parse_cello_section_maps


def fixture_map(map_key):
    spec = MAPS[map_key]
    lines = ["<control>", "default_path=Strings\\Cello Section\\pizzT\\", "<global>"]
    roots = [36, 40, 43, 47, 50, 53, 57, 60, 64, 67, 71, 74, 77]
    names = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
    folder = {"pizzicato":"pizzT","spiccato":"spic","sustain_quiet":"susvib","sustain_vibrato":"susvib","tremolo":"trem"}[map_key]
    entries=[]
    if map_key in ("pizzicato","spiccato"):
        for rr in (1,2):
            entries.append(["<group>", "seq_length=2", f"seq_position={rr}"])
            for root in roots:
                pitch=f"{names[root%12]}{root//12-2}"
                prefix="pizzT" if map_key=="pizzicato" else "spic"
                for layer,low,high in ((1,0,62),(2,63,127)):
                    entries.append(["<region>",f"sample={prefix}_{pitch}_v{layer}_RR{rr}.wav",f"pitch_keycenter={root}",f"lokey={root}",f"hikey={root}",f"lovel={low}",f"hivel={high}","volume=0"])
    else:
        for i,root in enumerate(roots):
            pitch=f"{names[root%12]}{root//12-2}"
            prefix={"sustain_quiet":"susvib","sustain_vibrato":"susvib","tremolo":"trem"}[map_key]
            layers=(1,) if map_key=="sustain_quiet" else (1,3) if map_key=="sustain_vibrato" else (1,2)
            for layer in layers:
                suffix=f"_{layer}_1.wav"
                if prefix in ("susvib","trem"):
                    filename=f"{prefix}_{pitch}_v{layer}{suffix}"
                low,high=(0,127) if map_key=="sustain_quiet" else (0,62) if layer==1 else (63,127)
                entries.append(["<region>",f"sample={filename}",f"pitch_keycenter={root}",f"lokey={root}",f"hikey={root}",f"lovel={low}",f"hivel={high}","volume=0"])
    for block in entries:
        lines.extend(block)
    return "\n".join(lines)


class CelloSectionMapTests(unittest.TestCase):
    def test_requires_all_five_maps_and_expected_region_shape(self):
        maps={key:fixture_map(key) for key in MAPS}
        result=parse_cello_section_maps(maps)
        self.assertEqual(len(result),170)
        self.assertEqual(len({x["source_path"] for x in result}),156)

    def test_requires_every_map(self):
        with self.assertRaisesRegex(ValueError,"five official"):
            parse_cello_section_maps({key:fixture_map(key) for key in list(MAPS)[:-1]})

    def test_rejects_a_mismatched_filename_root(self):
        maps={key:fixture_map(key) for key in MAPS}
        maps["pizzicato"]=maps["pizzicato"].replace("pitch_keycenter=57","pitch_keycenter=58",1)
        with self.assertRaisesRegex(ValueError,"root does not match"):
            parse_cello_section_maps(maps)


if __name__ == "__main__":
    unittest.main()
