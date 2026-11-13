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
    def make_bank(self, root: Path, instrument: str, source_id: str, sample_rate: int = 48000, session_id: str | None = None, articulation: str = "sustain"):
        sample_path = root / "samples" / "e2.wav"
        sample_path.parent.mkdir(parents=True)
        with wave.open(str(sample_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(b"".join(
                int(6000 * math.sin(2 * math.pi * 82.4 * i / sample_rate)).to_bytes(2, "little", signed=True)
                for i in range(sample_rate // 10)
            ))
        (root / "source").mkdir()
        (root / "source" / "SOURCE_LICENSE.txt").write_text(
            "CC0 1.0 Universal. To the extent possible under law, waived all copyright.", encoding="utf-8"
        )
        session = session_id or source_id + "_cc0"
        (root / "bank.json").write_text(json.dumps({
            "format_version": 1,
            "recording_sessions": {session: {"instrument_model": instrument, "performer": "Recorded source"}},
            "samples": [{
                "instrument": instrument, "midi_note": 40,
                "velocity_min": 1, "velocity_max": 127,
                "articulation": articulation, "string": "LowE" if instrument in ("nylon_guitar", "acoustic_guitar") else None,
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

    def test_installs_cc0_electric_bass_fingerstyle_and_pick_banks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "electric-bass", root / "installed"
            source.mkdir()
            session = "freepats_electric_bass_cc0"
            (source / "LICENSE-CC0.txt").write_text(
                "CC0 1.0 Universal. Creative Commons Zero.", encoding="utf-8"
            )
            samples = []
            for articulation, note, frequency in (
                ("fingerstyle", 28, 82), ("pick", 33, 110)
            ):
                relative = f"{articulation}/E.wav"
                sample_path = source / relative
                sample_path.parent.mkdir(parents=True, exist_ok=True)
                with wave.open(str(sample_path), "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(48000)
                    wav.writeframes(b"".join(
                        int(6500 * math.sin(2 * math.pi * frequency * i / 48000)
                            * (1.0 - i / 9600)).to_bytes(2, "little", signed=True)
                        for i in range(9600)
                    ))
                samples.append({
                    "instrument": "electric_bass", "midi_note": note,
                    "velocity_min": 1, "velocity_max": 127,
                    "articulation": articulation, "round_robin_index": 0,
                    "playable_key_min": note, "playable_key_max": note,
                    "one_shot": False, "path": relative,
                    "recording_session_id": session,
                })
            (source / "bank.json").write_text(json.dumps({
                "format_version": 1,
                "recording_sessions": {
                    session: {
                        "instrument_model": "Yamaha RBX electric bass guitar",
                        "performer": "Andrea Biasior",
                    }
                },
                "samples": samples,
            }), encoding="utf-8")
            report = install_recorded_banks([source], target)
            bank = load_sample_bank(target)
            self.assertTrue(report["installed"])
            self.assertEqual(report["instrument_count"], 1)
            self.assertEqual(report["sample_count"], 2)
            self.assertEqual({sample.articulation for sample in bank.samples},
                             {"fingerstyle", "pick"})
            self.assertEqual(
                {(sample.playable_key_min, sample.playable_key_max) for sample in bank.samples},
                {(28, 28), (33, 33)},
            )
            self.assertTrue(
                (target / "provenance" / "electric_bass" / "SOURCE_LICENSE.txt").is_file()
            )
            output = root / "electric-bass-preview.wav"
            rendered = render_sample_events([
                {"instrument": "electric_bass", "midi_note": 28,
                 "articulation": "fingerstyle", "start_seconds": 0,
                 "duration_seconds": 0.15, "velocity": 90},
                {"instrument": "electric_bass", "midi_note": 33,
                 "articulation": "pick", "start_seconds": 0.2,
                 "duration_seconds": 0.15, "velocity": 90},
            ], bank, output, sample_rate=22050)
            self.assertEqual(rendered["events_rendered"], 2)
            self.assertEqual(rendered["source"], "recorded_sample_bank")
            with wave.open(str(output), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 2)
                self.assertTrue(any(wav.readframes(wav.getnframes())))

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


    def test_installs_violin_and_concert_flute_banks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            violin, flute, target = root / "violin", root / "flute", root / "installed"
            violin.mkdir(); flute.mkdir()
            self.make_bank(violin, "solo_violin", "vsco2_solo_violin", 44100)
            self.make_bank(flute, "concert_flute", "vsco2_concert_flute", 44100)
            report = install_recorded_banks([violin, flute], target)
            bank = load_sample_bank(target)
            self.assertTrue(report["installed"])
            self.assertEqual(report["instrument_count"], 2)
            self.assertEqual(report["sample_count"], 2)
            self.assertEqual({s.instrument for s in bank.samples},
                             {"solo_violin", "concert_flute"})
            self.assertTrue((target / "provenance" / "solo_violin" / "SOURCE_LICENSE.txt").is_file())
            self.assertTrue((target / "provenance" / "concert_flute" / "SOURCE_LICENSE.txt").is_file())


    def test_installs_dan_tranh_and_baroque_recorder_banks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            dan_tranh, recorder, target = root / "dan-tranh", root / "recorder", root / "installed"
            dan_tranh.mkdir(); recorder.mkdir()
            self.make_bank(
                dan_tranh, "dan_tranh", "vcsl-dan-tranh", 44100,
                "vcsl_dan_tranh_normal", articulation="pluck",
            )
            self.make_bank(
                recorder, "baroque_soprano_recorder", "vcsl-recorder", 44100,
                "vcsl_baroque_soprano_recorder",
            )
            report = install_recorded_banks([dan_tranh, recorder], target)
            bank = load_sample_bank(target)
            self.assertTrue(report["installed"])
            self.assertEqual(report["instrument_count"], 2)
            self.assertEqual(report["sample_count"], 2)
            self.assertEqual(
                {sample.instrument for sample in bank.samples},
                {"dan_tranh", "baroque_soprano_recorder"},
            )
            self.assertTrue((target / "provenance" / "dan_tranh" / "SOURCE_LICENSE.txt").is_file())
            self.assertTrue((target / "provenance" / "baroque_soprano_recorder" / "SOURCE_LICENSE.txt").is_file())
            rendered = render_sample_events([
                {"instrument": "dan_tranh", "midi_note": 40, "articulation": "pluck",
                 "start_seconds": 0, "duration_seconds": 0.1, "velocity": 90},
                {"instrument": "baroque_soprano_recorder", "midi_note": 40,
                 "articulation": "sustain", "start_seconds": 0.2,
                 "duration_seconds": 0.1, "velocity": 90},
            ], bank, root / "world-instruments.wav", sample_rate=22050)
            self.assertEqual(rendered["events_rendered"], 2)
            self.assertEqual(rendered["source"], "recorded_sample_bank")

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
            with self.assertRaisesRegex(ValueError, "Only validated CC0 recorded instrument banks"):
                install_recorded_banks([source], target)
            self.assertFalse(target.exists())


    def test_installs_cajon_kalimba_and_contrabass_with_playback_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            specifications = [
                ("cajon", "vcsl_cajon_recordings", 60, "bass", True, 0.0, 0.0),
                ("kalimba", "vcsl_kalimba_kenya", 63, "pluck", False, -12.5, -1.5),
                ("contrabass", "d_smolken_rubner_pizzicato", 38, "pizzicato", False, 0.0, 0.0),
            ]
            sources = []
            for instrument, session, note, articulation, one_shot, tuning, gain in specifications:
                source = root / instrument
                source.mkdir()
                (source / "LICENSE-CC0.txt").write_text(
                    "CC0 1.0 Universal. Creative Commons Zero.", encoding="utf-8"
                )
                relative = "samples/note.wav"
                sample_path = source / relative
                sample_path.parent.mkdir(parents=True)
                with wave.open(str(sample_path), "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(44100)
                    wav.writeframes(b"".join(
                        int(5000 * math.sin(2 * math.pi * 220 * i / 44100)).to_bytes(
                            2, "little", signed=True
                        ) for i in range(2205)
                    ))
                (source / "bank.json").write_text(json.dumps({
                    "format_version": 1,
                    "recording_sessions": {
                        session: {"instrument_model": instrument, "performer": "Recorded source"}
                    },
                    "samples": [{
                        "instrument": instrument, "midi_note": note,
                        "velocity_min": 1, "velocity_max": 127,
                        "articulation": articulation, "round_robin_index": 0,
                        "one_shot": one_shot, "tuning_cents": tuning, "gain_db": gain,
                        "path": relative, "recording_session_id": session,
                    }],
                }), encoding="utf-8")
                sources.append(source)

            target = root / "combined"
            report = install_recorded_banks(sources, target)
            bank = load_sample_bank(target)
            self.assertTrue(report["installed"])
            self.assertEqual(report["instrument_count"], 3)
            self.assertEqual(report["sample_count"], 3)
            by_instrument = {sample.instrument: sample for sample in bank.samples}
            self.assertTrue(by_instrument["cajon"].one_shot)
            self.assertEqual(by_instrument["kalimba"].tuning_cents, -12.5)
            self.assertEqual(by_instrument["kalimba"].gain_db, -1.5)
            self.assertEqual(by_instrument["contrabass"].articulation, "pizzicato")

    def test_installs_vcsl_concert_harp_and_preserves_velocity_crossfades(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "harp", root / "installed"
            source.mkdir()
            (source / "LICENSE-CC0.txt").write_text(
                "CC0 1.0 Universal. Creative Commons Zero.", encoding="utf-8"
            )
            session = "vcsl_concert_harp_cc0"
            samples = []
            for filename, fade_field in (("mf.wav", "velocity_fade_out"),
                                         ("f.wav", "velocity_fade_in")):
                sample_path = source / "samples" / filename
                sample_path.parent.mkdir(parents=True, exist_ok=True)
                with wave.open(str(sample_path), "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(44100)
                    wav.writeframes(b"\\x00\\x00" * 4410)
                entry = {
                    "instrument": "concert_harp", "midi_note": 60,
                    "velocity_min": 1, "velocity_max": 127,
                    "articulation": "sustain", "path": f"samples/{filename}",
                    "recording_session_id": session,
                    fade_field: [70, 100],
                }
                samples.append(entry)
            (source / "bank.json").write_text(json.dumps({
                "format_version": 1,
                "recording_sessions": {session: {"performer": "VCSL recording"}},
                "samples": samples,
            }), encoding="utf-8")
            report = install_recorded_banks([source], target)
            bank = load_sample_bank(target)
            self.assertTrue(report["installed"])
            self.assertEqual({sample.instrument for sample in bank.samples}, {"concert_harp"})
            self.assertEqual(len(bank.samples), 2)
            self.assertEqual(
                {sample.velocity_fade_in for sample in bank.samples if sample.velocity_fade_in},
                {(70, 100)},
            )
            self.assertEqual(
                {sample.velocity_fade_out for sample in bank.samples if sample.velocity_fade_out},
                {(70, 100)},
            )


if __name__ == "__main__":
    unittest.main()
