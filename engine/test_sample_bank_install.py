import json
import math
import tempfile
import unittest
import wave
from pathlib import Path

from sample_bank import load_sample_bank
from sample_bank_install import install_recorded_banks
from sample_renderer import render_sample_events


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
            output = root / "installed-audition.wav"
            rendered = render_sample_events([{
                "instrument": "nylon_guitar",
                "midi_note": 40,
                "start_seconds": 0,
                "duration_seconds": 0.05,
                "velocity": 90,
                "articulation": "sustain",
                "guitar_string": "LowE",
            }], bank, output, sample_rate=22050)
            self.assertEqual(rendered["events_rendered"], 1)
            self.assertEqual(rendered["source"], "recorded_sample_bank")
            with wave.open(str(output), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 2)
                self.assertEqual(wav.getsampwidth(), 2)
                self.assertTrue(any(wav.readframes(wav.getnframes())))

    def test_installs_verified_meta_piano_bank_and_preserves_cc0_license(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "piano", root / "installed"
            source.mkdir()
            sample_path = source / "piano" / "sustain" / "C4.wav"
            sample_path.parent.mkdir(parents=True)
            with wave.open(str(sample_path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(48000)
                wav.writeframes(b"".join(
                    int(5000 * math.sin(2 * math.pi * 261.6 * i / 48000)).to_bytes(
                        2, "little", signed=True
                    ) for i in range(4800)
                ))
            (source / "SOURCE_LICENSE_CC0.txt").write_text(
                "CC0 1.0 Universal. Creative Commons Zero.", encoding="utf-8"
            )
            session = "meta_piano_cc0"
            (source / "bank.json").write_text(json.dumps({
                "format_version": 1,
                "recording_sessions": {
                    session: {"instrument_model": "Meta Piano", "performer": "Meta Audio"}
                },
                "samples": [{
                    "instrument": "piano", "midi_note": 60,
                    "velocity_min": 1, "velocity_max": 127,
                    "articulation": "sustain",
                    "path": "piano/sustain/C4.wav",
                    "recording_session_id": session,
                }],
            }), encoding="utf-8")
            report = install_recorded_banks([source], target)
            bank = load_sample_bank(target)
            self.assertTrue(report["installed"])
            self.assertEqual(len(bank.samples), 1)
            self.assertEqual(bank.samples[0].instrument, "piano")
            self.assertTrue(
                (target / "provenance" / "piano" / "SOURCE_LICENSE.txt").is_file()
            )
            output = root / "piano-preview.wav"
            rendered = render_sample_events([{
                "instrument": "piano", "midi_note": 60,
                "start_seconds": 0, "duration_seconds": 0.05, "velocity": 90,
            }], bank, output, sample_rate=22050)
            self.assertEqual(rendered["events_rendered"], 1)
            self.assertEqual(rendered["source"], "recorded_sample_bank")

    def test_installs_percussion_round_robins_and_one_shot_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "drums", root / "installed"
            source.mkdir()
            session = "virtuosity_drums_cc0_pinned"
            (source / "LICENSE-CC0.txt").write_text(
                "CC0 1.0 Universal. Creative Commons Zero.", encoding="utf-8"
            )
            instruments = [
                ("kick", 36, "snares_on", 0, "kick/take-1.wav"),
                ("kick", 36, "snares_on", 1, "kick/take-2.wav"),
                ("snare", 38, "center", 0, "snare/center.wav"),
                ("closed_hat", 42, "closed", 0, "closed_hat/closed.wav"),
                ("open_hat", 42, "open", 0, "open_hat/open.wav"),
            ]
            samples = []
            for instrument, note, articulation, rr, relative in instruments:
                sample_path = source / relative
                sample_path.parent.mkdir(parents=True, exist_ok=True)
                with wave.open(str(sample_path), "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(44100)
                    wav.writeframes(b"".join(
                        int(7000 * math.sin(2 * math.pi * (70 + rr * 13) * i / 44100)
                            * (1.0 - i / 4410)).to_bytes(2, "little", signed=True)
                        for i in range(4410)
                    ))
                samples.append({
                    "instrument": instrument, "midi_note": note,
                    "velocity_min": 1, "velocity_max": 127,
                    "articulation": articulation, "round_robin_index": rr,
                    "one_shot": True, "path": relative,
                    "recording_session_id": session,
                })
            (source / "bank.json").write_text(json.dumps({
                "format_version": 1,
                "recording_sessions": {
                    session: {
                        "instrument_model": "Virtuosity house kit",
                        "performer": "Austin McMahon",
                        "microphone": "kick mic",
                    }
                },
                "samples": samples,
            }), encoding="utf-8")

            report = install_recorded_banks([source], target)
            bank = load_sample_bank(target)
            self.assertTrue(report["installed"])
            self.assertEqual(report["instrument_count"], 4)
            self.assertEqual(report["sample_count"], 5)
            self.assertEqual({sample.instrument for sample in bank.samples},
                             {"kick", "snare", "closed_hat", "open_hat"})
            self.assertTrue(all(sample.one_shot for sample in bank.samples))
            self.assertEqual(
                sorted(sample.round_robin_index for sample in bank.samples
                       if sample.instrument == "kick"),
                [0, 1],
            )
            self.assertTrue(
                (target / "provenance" / "kick" / "SOURCE_LICENSE.txt").is_file()
            )

            output = root / "percussion-installed.wav"
            events = [
                {"instrument": instrument, "midi_note": note,
                 "articulation": articulation, "start_seconds": start,
                 "duration_seconds": 0.01, "velocity": 90}
                for instrument, note, articulation, start in (
                    ("kick", 36, "snares_on", 0.0),
                    ("kick", 36, "snares_on", 0.2),
                    ("snare", 38, "center", 0.4),
                    ("closed_hat", 42, "closed", 0.6),
                    ("open_hat", 42, "open", 0.8),
                )
            ]
            rendered = render_sample_events(events, bank, output, sample_rate=22050)
            self.assertEqual(rendered["events_rendered"], 5)
            self.assertEqual(rendered["sample_selection"]["one_shot_round_robin_events"], 5)
            self.assertEqual(
                [item["round_robin_index"] for item in
                 rendered["sample_selection"]["one_shot_round_robin_selections"][:2]],
                [0, 1],
            )
            with wave.open(str(output), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 2)
                self.assertTrue(any(wav.readframes(wav.getnframes())))

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
            self.make_bank(source, "synth", "meta-nylon-guitar")
            with self.assertRaisesRegex(ValueError, "Only validated Meta"):
                install_recorded_banks([source], target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
