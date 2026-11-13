import json
import math
import tempfile
import unittest
import wave
from pathlib import Path

from build_contrabass_supplement_banks import build_contrabass_supplement_banks
from sample_bank import load_sample_bank


class BuildContrabassSupplementBanksTests(unittest.TestCase):
    def make_source(self, root, session, entries, channels):
        root.mkdir()
        (root / "LICENSE-CC0.txt").write_text(
            "CC0 1.0 Universal. Creative Commons Zero.", encoding="utf-8"
        )
        (root / "provenance.json").write_text(
            json.dumps({"source_session": session}), encoding="utf-8"
        )
        samples = []
        for index, entry in enumerate(entries):
            relative = f"pizzicato/{session}-{index}.wav"
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            with wave.open(str(path), "wb") as audio:
                audio.setnchannels(channels)
                audio.setsampwidth(2)
                audio.setframerate(44100)
                frame = b"\x00\x10" * channels
                audio.writeframes(frame * 2205)
            samples.append({
                "instrument": "contrabass",
                "midi_note": entry["note"],
                "velocity_min": entry["low"],
                "velocity_max": entry["high"],
                "articulation": "pizzicato",
                "round_robin_index": entry["rr"],
                "playable_key_min": entry["zone"][0],
                "playable_key_max": entry["zone"][1],
                "recording_session_id": session,
                "path": relative,
            })
        (root / "bank.json").write_text(json.dumps({
            "format_version": 1,
            "recording_sessions": {session: {"instrument_model": session}},
            "samples": samples,
        }), encoding="utf-8")

    def test_builds_separate_exact_root_installer_banks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            meatbass_source = root / "meatbass-source"
            vsco2_source = root / "vsco2-source"
            self.make_source(
                meatbass_source, "karoryfer_meatbass_pizzicato",
                [{"note": 27, "low": 97, "high": 127, "rr": rr, "zone": (26, 28)}
                 for rr in range(4)],
                1,
            )
            self.make_source(
                vsco2_source, "vsco2_ce_contrabass_pizzicato",
                [{"note": 34, "low": 63, "high": 127, "rr": rr, "zone": (34, 34)}
                 for rr in range(2)],
                2,
            )
            meatbass_out = root / "meatbass-supplement"
            vsco2_out = root / "vsco2-supplement"
            report = build_contrabass_supplement_banks(
                meatbass_source, vsco2_source, meatbass_out, vsco2_out
            )
            self.assertEqual(report["total_supplement_samples"], 6)
            meatbass = load_sample_bank(meatbass_out)
            vsco2 = load_sample_bank(vsco2_out)
            self.assertEqual(len(meatbass.samples), 4)
            self.assertEqual(len(vsco2.samples), 2)
            self.assertEqual(
                {(s.midi_note, s.velocity_min, s.velocity_max,
                  s.playable_key_min, s.playable_key_max,
                  s.selection_priority, s.selection_priority_min_velocity)
                 for s in meatbass.samples},
                {(27, 97, 127, 27, 27, 10, 121)},
            )
            self.assertEqual(
                {(s.midi_note, s.velocity_min, s.velocity_max,
                  s.playable_key_min, s.playable_key_max,
                  s.selection_priority, s.selection_priority_min_velocity)
                 for s in vsco2.samples},
                {(34, 63, 127, 34, 34, 10, 121)},
            )
            self.assertEqual({s.channels for s in meatbass.samples}, {1})
            self.assertEqual({s.channels for s in vsco2.samples}, {2})
            self.assertTrue((meatbass_out / "provenance.json").is_file())
            self.assertTrue((vsco2_out / "provenance.json").is_file())


if __name__ == "__main__":
    unittest.main()
