import json
import math
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank import load_sample_bank
from sample_bank_install import install_recorded_banks


class SampleBankInstallTests(unittest.TestCase):
    def make_bank(self, root: Path, instrument: str, source_id: str):
        sample_path = root / "samples" / "e2.wav"
        sample_path.parent.mkdir(parents=True)
        with wave.open(str(sample_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(48000)
            wav.writeframes(b"".join(
                int(6000 * math.sin(2 * math.pi * 82.4 * i / 48000)).to_bytes(2, "little", signed=True)
                for i in range(4800)
            ))
        (root / "source").mkdir()
        (root / "source" / "SOURCE_LICENSE.txt").write_text(
            "CC0 1.0 Universal. To the extent possible under law, waived all copyright.", encoding="utf-8"
        )
        session = source_id + "_cc0"
        (root / "bank.json").write_text(json.dumps({
            "format_version": 1,
            "recording_sessions": {session: {"instrument_model": instrument, "performer": "Recorded source"}},
            "samples": [{
                "instrument": instrument, "midi_note": 40,
                "velocity_min": 1, "velocity_max": 127,
                "articulation": "sustain", "string": "LowE",
                "path": "samples/e2.wav", "recording_session_id": session,
            }],
        }), encoding="utf-8")

    def test_installs_and_validates_combined_recorded_bank(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            nylon, steel, target = root / "nylon", root / "steel", root / "installed"
            nylon.mkdir(); steel.mkdir()
            self.make_bank(nylon, "nylon_guitar", "meta-nylon-guitar")
            self.make_bank(steel, "acoustic_guitar", "meta-steel-guitar")
            report = install_recorded_banks([nylon, steel], target)
            bank = load_sample_bank(target)
            self.assertTrue(report["installed"])
            self.assertEqual(len(bank.samples), 2)
            self.assertEqual({s.instrument for s in bank.samples}, {"nylon_guitar", "acoustic_guitar"})
            self.assertTrue((target / "provenance" / "nylon_guitar" / "SOURCE_LICENSE.txt").is_file())

    def test_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "nylon", root / "installed"
            source.mkdir()
            self.make_bank(source, "nylon_guitar", "meta-nylon-guitar")
            target.mkdir()
            with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
                install_recorded_banks([source], target)

    def test_rejects_missing_cc0_license_without_publishing(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "nylon", root / "installed"
            source.mkdir()
            self.make_bank(source, "nylon_guitar", "meta-nylon-guitar")
            (source / "source" / "SOURCE_LICENSE.txt").write_text("All rights reserved", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "does not identify CC0"):
                install_recorded_banks([source], target)
            self.assertFalse(target.exists())

    def test_rejects_unknown_instrument(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "other", root / "installed"
            source.mkdir()
            self.make_bank(source, "piano", "meta-nylon-guitar")
            with self.assertRaisesRegex(ValueError, "Only validated Meta"):
                install_recorded_banks([source], target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
