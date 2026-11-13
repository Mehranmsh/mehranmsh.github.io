import importlib.util
import json
import hashlib
import os
import struct
import wave
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest import mock
from pathlib import Path

PREFLIGHT_PATH = Path(__file__).with_name("preflight.py")
preflight_spec = importlib.util.spec_from_file_location("mehran_studio_preflight", PREFLIGHT_PATH)
preflight = importlib.util.module_from_spec(preflight_spec)
preflight_spec.loader.exec_module(preflight)

MODULE_PATH = Path(__file__).with_name("server.py")
spec = importlib.util.spec_from_file_location("mehran_studio_server", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StudioControlPlaneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        module.ROOT = Path(self.temp.name)
        module.DB_PATH = module.ROOT / "test.sqlite3"
        module.MIN_FREE_BYTES = 0
        module.MAX_PROJECTS = 2
        module.TOKEN = "t" * 40
        module.database().close()
        self.models = module.ROOT / "models"
        self.models.mkdir()
        self.httpd = module.ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, path, method="GET", payload=None, token=True):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {}
        if token:
            headers["Authorization"] = "Bearer " + module.TOKEN
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=body, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        status = response.code
        body = response.read().decode("utf-8")
        response.close()
        return status, json.loads(body)

    def test_server_bind_rejects_public_interfaces(self):
        for host in ("0.0.0.0", "192.168.1.20", "::", "localhost"):
            with self.subTest(host=host):
                with self.assertRaises(SystemExit):
                    module.validate_server_config(host, 8765)

    def test_server_bind_accepts_loopback_and_valid_port_only(self):
        module.validate_server_config("127.0.0.1", 8765)
        module.validate_server_config("127.20.30.40", 65535)
        for port in (0, -1, 65536, "8765"):
            with self.subTest(port=port):
                with self.assertRaises(SystemExit):
                    module.validate_server_config("127.0.0.1", port)

    def test_main_refuses_public_bind_before_starting(self):
        with mock.patch.object(module, "TOKEN", "t" * 40), \
             mock.patch.object(module, "HOST", "0.0.0.0"):
            with self.assertRaises(SystemExit):
                module.main()

    def test_http_authentication_is_required(self):
        status, payload = self.request("/health", token=False)
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"], "unauthorized")

    def test_health_endpoint_never_claims_engine_is_ready(self):
        status, payload = self.request("/health")
        self.assertEqual(status, 200)
        self.assertFalse(payload["engine"]["ready"])
        self.assertFalse(payload["external_api_calls"])
        self.assertFalse(payload["paid_fallback"])

    def test_job_submission_is_hard_stopped_without_local_engine(self):
        status, payload = self.request("/v1/jobs", method="POST", payload={"kind": "song"})
        self.assertEqual(status, 503)
        self.assertFalse(payload["job_created"])
        self.assertFalse(payload["charged"])

    def test_authenticated_compose_creates_plan_and_midi_file(self):
        status, payload = self.request("/v1/compose", method="POST", payload={
            "title": "برگرد", "lyrics": "دلم گرفته\nاز این شب سرد\nبرگرد ای عشق\nبه خانه برگرد",
            "genre": "pop", "bpm": 84
        })
        self.assertEqual(status, 201, payload)
        self.assertTrue(payload["composition_created"])
        self.assertFalse(payload["audio_rendered"])
        self.assertEqual(payload["plan"]["title"], "برگرد")
        self.assertEqual(payload["midi"]["tracks"], 7)
        self.assertGreater(payload["midi"]["guitar_note_events"], 0)
        self.assertGreater(payload["midi"]["piano_note_events"], 0)
        self.assertGreater(payload["midi"]["guitar_note_events"], 0)
        self.assertGreater(payload["midi"]["bass_note_events"], 0)
        self.assertGreater(payload["midi"]["drum_hits"], 0)
        self.assertEqual(payload["midi"]["drum_channel"], 10)
        midi_path = Path(payload["midi"]["local_path"])
        self.assertTrue(midi_path.is_file())
        self.assertEqual(midi_path.read_bytes()[:4], b"MThd")

    def test_authenticated_instrumental_first_creates_midi_without_placeholder_lyrics(self):
        status, payload = self.request("/v1/compose-instrumental", method="POST", payload={
            "title": "شب روشن", "genre": "pop", "mood": "hopeful",
            "bpm": 104, "phrase_count": 8,
        })
        self.assertEqual(status, 201, payload)
        self.assertTrue(payload["composition_created"])
        self.assertFalse(payload["audio_rendered"])
        plan = payload["plan"]
        self.assertEqual(plan["source_mode"], "instrumental_first")
        self.assertIsNone(plan["lyrics"])
        self.assertEqual(plan["lyric_status"], "not_started")
        self.assertEqual(plan["analysis"]["line_count"], 0)
        self.assertEqual(len(plan["composition"]["melody"]), 8)
        self.assertEqual(len(plan["lyric_fit_guide"]), 8)
        self.assertEqual(payload["midi"]["tracks"], 7)
        self.assertGreater(payload["midi"]["guitar_note_events"], 0)
        self.assertGreater(payload["midi"]["piano_note_events"], 0)
        self.assertGreater(payload["midi"]["bass_note_events"], 0)
        self.assertGreater(payload["midi"]["drum_hits"], 0)
        midi_path = Path(payload["midi"]["local_path"])
        self.assertEqual(midi_path.read_bytes()[:4], b"MThd")

    def test_authenticated_co_creation_fits_lyrics_without_replacing_instrumental_music(self):
        payload = {
            "title": "همراه", "genre": "pop", "mood": "hopeful",
            "bpm": 104, "phrase_count": 8,
            "lyrics": "فردا دوباره می‌رسد\nآفتاب از راه می‌رسد\nدست من را رها نکن\nتا بهار خانه مانده",
        }
        status, result = self.request("/v1/co-create", method="POST", payload=payload)
        self.assertEqual(status, 201, result)
        self.assertTrue(result["composition_created"])
        self.assertFalse(result["audio_rendered"])
        plan = result["plan"]
        self.assertEqual(plan["source_mode"], "co_creation")
        self.assertEqual(plan["lyric_status"], "provided_and_aligned")
        self.assertTrue(plan["co_creation"]["music_preserved_during_lyric_fit"])
        self.assertFalse(plan["co_creation"]["melody_note_events_changed"])
        self.assertFalse(plan["co_creation"]["harmony_changed"])
        self.assertTrue(plan["co_creation"]["arrangement_blueprint_preserved"])
        self.assertEqual(plan["co_creation"]["aligned_lyric_lines"], 4)
        self.assertEqual(len(plan["composition"]["melody"]), 8)
        self.assertEqual(plan["composition"]["melody"][0]["lyric_line"], "فردا دوباره می‌رسد")
        self.assertEqual(len(plan["composition"]["melody"][0]["note_lyric_map"]), 8)
        self.assertEqual(plan["composition"]["melody"][4]["note_lyric_map"], [])
        self.assertEqual(result["midi"]["tracks"], 7)
        midi_path = Path(result["midi"]["local_path"])
        self.assertEqual(midi_path.read_bytes()[:4], b"MThd")

    def test_co_creation_rejects_lyrics_beyond_melody_capacity_and_requires_auth(self):
        too_many_lines = "\n".join(["یک خط"] * 9)
        status, result = self.request(
            "/v1/co-create", method="POST",
            payload={"lyrics": too_many_lines, "phrase_count": 8},
        )
        self.assertEqual(status, 400)
        self.assertEqual(result["error"], "lyrics_exceed_melody_capacity")
        status, result = self.request(
            "/v1/co-create", method="POST",
            payload={"lyrics": "یک شعر"}, token=False,
        )
        self.assertEqual(status, 401)
        self.assertEqual(result["error"], "unauthorized")

    def test_co_creation_revision_preserves_harmony_rhythm_and_arrangement(self):
        status, created = self.request(
            "/v1/co-create", method="POST",
            payload={"lyrics": chr(10).join(["فردا می‌رسد", "آفتاب می‌تابد"]), "mood": "hopeful", "phrase_count": 8},
        )
        self.assertEqual(status, 201, created)
        original = created["plan"]
        original_notes = [list(item["midi_notes"]) for item in original["composition"]["melody"]]
        original_durations = [list(item["note_durations_ticks"]) for item in original["composition"]["melody"]]
        original_chords = list(original["composition"]["chord_progression"])
        original_arrangement = original["composition"]["arrangement_blueprint"]
        revised_notes = [[min(88, max(48, note + (1 if i == 0 else 0)))
                          for note in phrase] for i, phrase in enumerate(original_notes)]
        status, revised = self.request(
            "/v1/revise-co-creation", method="POST",
            payload={
                "plan": original,
                "lyrics": chr(10).join(["فردا دوباره می‌رسد", "خورشید می‌تابد"]),
                "melody_notes": revised_notes,
            },
        )
        self.assertEqual(status, 200, revised)
        plan = revised["plan"]
        self.assertEqual(plan["co_creation"]["last_revision"], "lyrics_and_melody")
        self.assertEqual(plan["co_creation"]["revision_count"], 1)
        self.assertTrue(plan["co_creation"]["melody_rhythm_preserved"])
        self.assertTrue(plan["co_creation"]["harmony_and_arrangement_preserved"])
        self.assertEqual(plan["composition"]["chord_progression"], original_chords)
        self.assertEqual(plan["composition"]["arrangement_blueprint"], original_arrangement)
        self.assertEqual([item["note_durations_ticks"] for item in plan["composition"]["melody"]], original_durations)
        self.assertEqual([item["midi_notes"] for item in plan["composition"]["melody"]], revised_notes)
        self.assertEqual(plan["composition"]["melody"][0]["lyric_line"], "فردا دوباره می‌رسد")
        self.assertEqual(revised["midi"]["tracks"], 7)
        self.assertEqual(Path(revised["midi"]["local_path"]).read_bytes()[:4], b"MThd")

    def test_co_creation_revision_rejects_changed_note_count_or_invalid_pitch(self):
        status, created = self.request(
            "/v1/co-create", method="POST",
            payload={"lyrics": "یک شعر", "phrase_count": 8},
        )
        self.assertEqual(status, 201, created)
        plan = created["plan"]
        bad_notes = [list(item["midi_notes"]) for item in plan["composition"]["melody"]]
        bad_notes[0][0] = 120
        status, result = self.request(
            "/v1/revise-co-creation", method="POST",
            payload={"plan": plan, "melody_notes": bad_notes},
        )
        self.assertEqual(status, 400)
        self.assertEqual(result["error"], "invalid_revision")
        status, result = self.request(
            "/v1/revise-co-creation", method="POST",
            payload={"plan": plan, "melody_notes": [[60]] * 8},
        )
        self.assertEqual(status, 400)
        self.assertEqual(result["error"], "invalid_revision")

    def test_instrumental_first_rejects_invalid_mood_and_phrase_count(self):
        for payload in ({"mood": "invented"}, {"phrase_count": True},
                        {"phrase_count": 17}, {"bpm": True}):
            with self.subTest(payload=payload):
                status, result = self.request(
                    "/v1/compose-instrumental", method="POST", payload=payload
                )
                self.assertEqual(status, 400, result)

    def test_sample_preview_serves_only_selected_authenticated_wav(self):
        bank_root = module.ROOT / "preview-bank"
        bank_root.mkdir()
        sample_path = bank_root / "piano-c4.wav"
        with wave.open(str(sample_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(44100)
            wav.writeframes(struct.pack("<" + "h" * 128, *([2048, -2048] * 64)))
        staccato_path = bank_root / "piano-c4-staccato.wav"
        with wave.open(str(staccato_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(44100)
            wav.writeframes(struct.pack("<" + "h" * 128, *([1024, -1024] * 64)))
        (bank_root / "bank.json").write_text(json.dumps({
            "format_version": 1,
            "samples": [
                {"instrument": "piano", "midi_note": 60, "path": "piano-c4.wav"},
                {"instrument": "piano", "midi_note": 60, "path": "piano-c4-staccato.wav",
                 "articulation": "staccato"},
            ],
        }), encoding="utf-8")
        with mock.patch.dict(os.environ, {"MEHRAN_SAMPLE_BANK": str(bank_root)}):
            request = urllib.request.Request(self.base + "/v1/sample-bank/preview?instrument=piano&note=60&velocity=80",
                                            headers={"Authorization": "Bearer " + module.TOKEN})
            response = urllib.request.urlopen(request, timeout=3)
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get("Content-Type"), "audio/wav")
            self.assertEqual(response.headers.get("Cache-Control"), "no-store")
            self.assertEqual(response.read(), sample_path.read_bytes())
            response.close()
            staccato = urllib.request.Request(
                self.base + "/v1/sample-bank/preview?instrument=piano&note=60&velocity=80&articulation=staccato",
                headers={"Authorization": "Bearer " + module.TOKEN},
            )
            with urllib.request.urlopen(staccato, timeout=3) as response:
                self.assertEqual(response.read(), staccato_path.read_bytes())
            invalid_articulation = urllib.request.Request(
                self.base + "/v1/sample-bank/preview?instrument=piano&note=60&velocity=80&articulation=bad%20label",
                headers={"Authorization": "Bearer " + module.TOKEN},
            )
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(invalid_articulation, timeout=3)
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
            invalid = urllib.request.Request(self.base + "/v1/sample-bank/preview?instrument=piano&note=200&velocity=80",
                                             headers={"Authorization": "Bearer " + module.TOKEN})
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(invalid, timeout=3)
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
            nearest_only = urllib.request.Request(self.base + "/v1/sample-bank/preview?instrument=piano&note=61&velocity=80",
                                                  headers={"Authorization": "Bearer " + module.TOKEN})
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(nearest_only, timeout=3)
            self.assertEqual(error.exception.code, 404)
            error.exception.close()
            denied = urllib.request.Request(self.base + "/v1/sample-bank/preview?instrument=piano&note=60&velocity=80")
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(denied, timeout=3)
            self.assertEqual(error.exception.code, 401)
            error.exception.close()

    def test_sample_recording_sheet_csv_is_authenticated_read_only_and_downloadable(self):
        request = urllib.request.Request(
            self.base + "/v1/sample-bank/recording-sheet.csv",
            headers={"Authorization": "Bearer " + module.TOKEN},
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            content = response.read().decode("utf-8-sig")
            self.assertEqual(response.status, 200)
            self.assertIn("text/csv", response.headers.get("Content-Type", ""))
            self.assertIn("attachment;", response.headers.get("Content-Disposition", ""))
            self.assertIn("instrument,instrument_label,articulation,midi_note", content)
            self.assertIn("piano,Acoustic grand piano,sustain,36,soft,1,48", content)
            self.assertIn("planned", content)
        denied = urllib.request.Request(self.base + "/v1/sample-bank/recording-sheet.csv")
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(denied, timeout=3)
        self.assertEqual(error.exception.code, 401)
        error.exception.close()

    def test_sample_recording_requirements_endpoint_is_authenticated_and_read_only(self):
        status, report = self.request("/v1/sample-bank/requirements")
        self.assertEqual(status, 200)
        self.assertTrue(report["read_only"])
        checklist = report["recording_checklist"]
        self.assertEqual(checklist["instrument_count"], 35)
        self.assertIn("tar", checklist["instruments"])
        self.assertIn("violin", checklist["instruments"])
        self.assertGreater(checklist["total_recording_targets"], 0)
        self.assertEqual(checklist["format_requirements"]["container"], "WAV")
        status, denied = self.request("/v1/sample-bank/requirements", token=False)
        self.assertEqual(status, 401)
        self.assertEqual(denied["error"], "unauthorized")
    def test_sample_bank_diagnostics_are_authenticated_read_only_and_report_gaps(self):
        bank_root = module.ROOT / "fixture-bank"
        bank_root.mkdir()
        sample_path = bank_root / "piano-c4.wav"
        with wave.open(str(sample_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(44100)
            wav.writeframes(struct.pack("<" + "h" * 256, *([4096, -4096] * 128)))
        (bank_root / "bank.json").write_text(json.dumps({
            "format_version": 1,
            "samples": [{
                "instrument": "piano", "midi_note": 60,
                "path": "piano-c4.wav",
                "loop_start_frame": 0, "loop_end_frame": 16,
            }],
        }), encoding="utf-8")
        with mock.patch.dict(os.environ, {"MEHRAN_SAMPLE_BANK": str(bank_root)}):
            status, report = self.request("/v1/sample-bank/diagnostics")
        self.assertEqual(status, 200)
        self.assertTrue(report["diagnostics_available"])
        self.assertTrue(report["read_only"])
        self.assertFalse(report["coverage"]["ready"])
        self.assertEqual(report["coverage"]["recorded_samples"], 1)
        self.assertEqual(report["coverage"]["covered_requirements"], 3)
        self.assertFalse(report["signal_quality"]["basic_signal_checks_pass"])
        self.assertEqual(report["signal_quality"]["samples_with_warnings"], 1)
        self.assertTrue(report["instrument_health"]["read_only"])
        self.assertEqual(report["instrument_health"]["instruments"]["piano"]["recorded_samples"], 1)
        self.assertEqual(report["instrument_health"]["instruments"]["piano"]["status"], "needs_attention")
        self.assertEqual(report["instrument_health"]["instruments"]["piano"]["looped_samples"], 1)
        self.assertEqual(report["instrument_health"]["instruments"]["piano"]["loop_boundary_warning_count"], 1)
        self.assertEqual(report["instrument_health"]["instruments"]["piano"]["max_loop_boundary_jump"], 0.25)
        self.assertEqual(report["instrument_health"]["instruments"]["acoustic_guitar"]["status"], "missing")
        self.assertTrue(sample_path.is_file())

    def test_sample_bank_diagnostics_fail_closed_when_bank_is_missing(self):
        missing = module.ROOT / "missing-bank"
        with mock.patch.dict(os.environ, {"MEHRAN_SAMPLE_BANK": str(missing)}):
            status, report = self.request("/v1/sample-bank/diagnostics")
        self.assertEqual(status, 503)
        self.assertEqual(report["error"], "sample_bank_unavailable")
        self.assertFalse(report["diagnostics_available"])
        self.assertFalse(missing.exists())

    def test_audio_compose_rejects_invalid_part_selection(self):
        status, payload = self.request("/v1/compose-audio", method="POST", payload={
            "lyrics": "برگرد ای عشق", "parts": ["guitar", "../outside"]
        })
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_composition_parts")
        self.assertFalse(payload["audio_rendered"])
        self.assertFalse(payload["charged"])

    def test_audio_compose_can_render_only_the_verified_guitar_part(self):
        fake_audio = {
            "format": "WAV PCM 16-bit", "sample_rate": 22050,
            "channels": 2, "duration_seconds": 2.0, "events_rendered": 12,
        }
        with (
            mock.patch.object(module, "load_sample_bank", return_value=object()),
            mock.patch.object(module, "compose_plan", return_value={"title": "test"}),
            mock.patch.object(module, "render_composition_to_wav", return_value=fake_audio) as render,
        ):
            status, payload = self.request("/v1/compose-audio", method="POST", payload={
                "title": "گیتار", "lyrics": "برگرد ای عشق", "parts": ["guitar"]
            })
        self.assertEqual(status, 201, payload)
        self.assertTrue(payload["audio_rendered"])
        self.assertEqual(payload["audio"]["parts"], ["guitar"])
        render.assert_called_once()
        self.assertEqual(render.call_args.kwargs["parts"], ["guitar"])
        self.assertEqual(render.call_args.kwargs["instruments"], {"guitar": "acoustic_guitar"})

    def test_audio_compose_routes_optional_recorded_instruments_to_exact_banks(self):
        fake_audio = {
            "format": "WAV PCM 16-bit", "sample_rate": 44100,
            "channels": 2, "duration_seconds": 2.0, "events_rendered": 24,
        }
        with mock.patch.object(module, "load_sample_bank", return_value=object()), \
             mock.patch.object(module, "compose_plan", return_value={"title": "test"}), \
             mock.patch.object(module, "render_composition_to_wav", return_value=fake_audio) as render:
            status, payload = self.request("/v1/compose-audio", method="POST", payload={
                "title": "Recorded instruments", "lyrics": "برگرد ای عشق",
                "parts": ["contrabass", "cajon", "kalimba"],
            })
        self.assertEqual(status, 201, payload)
        self.assertTrue(payload["audio_rendered"])
        self.assertEqual(payload["audio"]["parts"], ["contrabass", "cajon", "kalimba"])
        self.assertEqual(render.call_args.kwargs["parts"], ["contrabass", "cajon", "kalimba"])
        self.assertEqual(render.call_args.kwargs["instruments"], {
            "contrabass": "contrabass", "cajon": "cajon", "kalimba": "kalimba",
        })

    def test_audio_compose_routes_strings_to_the_exact_solo_violin_bank(self):
        fake_audio = {
            "format": "WAV PCM 16-bit", "sample_rate": 44100,
            "channels": 2, "duration_seconds": 2.0, "events_rendered": 24,
        }
        with mock.patch.object(module, "load_sample_bank", return_value=object()), \
             mock.patch.object(module, "compose_plan", return_value={"title": "test"}), \
             mock.patch.object(module, "render_composition_to_wav", return_value=fake_audio) as render:
            status, payload = self.request("/v1/compose-audio", method="POST", payload={
                "title": "String layer", "lyrics": "برگرد ای عشق", "parts": ["strings"],
            })
        self.assertEqual(status, 201, payload)
        self.assertTrue(payload["audio_rendered"])
        self.assertEqual(payload["audio"]["parts"], ["strings"])
        self.assertEqual(render.call_args.kwargs["parts"], ["strings"])
        self.assertEqual(render.call_args.kwargs["instruments"], {"strings": "solo_violin"})

    def test_audio_compose_routes_nylon_guitar_to_its_exact_recorded_bank(self):
        fake_audio = {"format": "WAV PCM 16-bit", "sample_rate": 44100,
                      "channels": 2, "duration_seconds": 2.0, "events_rendered": 12}
        with (
            mock.patch.object(module, "load_sample_bank", return_value=object()),
            mock.patch.object(module, "compose_plan", return_value={"title": "test"}),
            mock.patch.object(module, "render_composition_to_wav", return_value=fake_audio) as render,
        ):
            status, payload = self.request("/v1/compose-audio", method="POST", payload={
                "title": "Nylon guitar", "lyrics": "برگرد ای عشق", "parts": ["nylon_guitar"],
            })
        self.assertEqual(status, 201, payload)
        self.assertEqual(render.call_args.kwargs["instruments"], {"nylon_guitar": "nylon_guitar"})

    def test_audio_compose_routes_harp_and_cello_to_exact_recorded_banks(self):
        fake_audio = {
            "format": "WAV PCM 16-bit", "sample_rate": 44100,
            "channels": 2, "duration_seconds": 2.0, "events_rendered": 24,
        }
        with mock.patch.object(module, "load_sample_bank", return_value=object()), \
             mock.patch.object(module, "compose_plan", return_value={"title": "test"}), \
             mock.patch.object(module, "render_composition_to_wav", return_value=fake_audio) as render:
            status, payload = self.request("/v1/compose-audio", method="POST", payload={
                "title": "Harp and cello", "lyrics": "برگرد ای عشق",
                "parts": ["harp", "cello"],
            })
        self.assertEqual(status, 201, payload)
        self.assertEqual(render.call_args.kwargs["instruments"], {
            "harp": "concert_harp", "cello": "cello_section",
        })

    def test_audio_compose_routes_recorder_and_dan_tranh_to_exact_banks(self):
        fake_audio = {
            "format": "WAV PCM 16-bit", "sample_rate": 44100,
            "channels": 2, "duration_seconds": 2.0, "events_rendered": 24,
        }
        with mock.patch.object(module, "load_sample_bank", return_value=object()), \
             mock.patch.object(module, "compose_plan", return_value={"title": "test"}), \
             mock.patch.object(module, "render_composition_to_wav", return_value=fake_audio) as render:
            status, payload = self.request("/v1/compose-audio", method="POST", payload={
                "title": "Recorder and Dan Tranh", "lyrics": "برگرد ای عشق",
                "parts": ["recorder", "dan_tranh"],
            })
        self.assertEqual(status, 201, payload)
        self.assertEqual(render.call_args.kwargs["instruments"], {
            "recorder": "baroque_soprano_recorder", "dan_tranh": "dan_tranh",
        })

    def test_audio_compose_routes_flute_to_exact_recorded_bank(self):
        fake_audio = {
            "format": "WAV PCM 16-bit", "sample_rate": 44100,
            "channels": 2, "duration_seconds": 2.0, "events_rendered": 24,
        }
        with mock.patch.object(module, "load_sample_bank", return_value=object()), \
             mock.patch.object(module, "compose_plan", return_value={"title": "test"}), \
             mock.patch.object(module, "render_composition_to_wav", return_value=fake_audio) as render:
            status, payload = self.request("/v1/compose-audio", method="POST", payload={
                "title": "Concert flute", "lyrics": "برگرد ای عشق",
                "parts": ["flute"],
            })
        self.assertEqual(status, 201, payload)
        self.assertEqual(render.call_args.kwargs["instruments"], {"flute": "concert_flute"})

    def test_audio_compose_fails_closed_without_a_local_sample_bank(self):
        status, payload = self.request("/v1/compose-audio", method="POST", payload={
            "title": "برگرد", "lyrics": "دلم گرفته\nاز این شب سرد",
            "genre": "pop", "bpm": 84
        })
        self.assertEqual(status, 503)
        self.assertEqual(payload["error"], "sample_bank_unavailable")
        self.assertFalse(payload["audio_rendered"])
        self.assertFalse(payload["charged"])

    def test_compose_rejects_invalid_lyrics_and_tempo(self):
        status, payload = self.request("/v1/compose", method="POST", payload={"lyrics": "  "})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_lyrics")
        status, payload = self.request("/v1/compose", method="POST",
                                       payload={"lyrics": "یک شعر", "bpm": 999})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_bpm")

    def test_authenticated_project_creation_persists(self):
        status, payload = self.request("/v1/projects", method="POST", payload={"name": "Local Demo", "kind": "song"})
        self.assertEqual(status, 201)
        self.assertEqual(payload["project"]["status"], "draft")
        status, listing = self.request("/v1/projects")
        self.assertEqual(status, 200)
        self.assertEqual(len(listing["projects"]), 1)
        self.assertEqual(listing["projects"][0]["name"], "Local Demo")


    def test_project_detail_update_and_delete_are_owner_authenticated(self):
        status, created = self.request("/v1/projects", method="POST", payload={"name": "Draft", "kind": "song"})
        self.assertEqual(status, 201)
        project_id = created["project"]["id"]
        status, updated = self.request("/v1/projects/" + project_id, method="PUT",
                                       payload={"name": "Final Mix", "status": "ready", "bpm": 112})
        self.assertEqual(status, 200)
        self.assertEqual(updated["project"]["name"], "Final Mix")
        self.assertEqual(updated["project"]["bpm"], 112)
        status, detail = self.request("/v1/projects/" + project_id)
        self.assertEqual(status, 200)
        self.assertEqual(detail["project"]["status"], "ready")
        status, deleted = self.request("/v1/projects/" + project_id, method="DELETE")
        self.assertEqual(status, 200)
        self.assertTrue(deleted["deleted"])
        status, missing = self.request("/v1/projects/" + project_id)
        self.assertEqual(status, 404)
        self.assertEqual(missing["error"], "project_not_found")

    def test_project_update_rejects_invalid_status_and_bpm(self):
        status, created = self.request("/v1/projects", method="POST", payload={"name": "Draft"})
        project_id = created["project"]["id"]
        status, invalid = self.request("/v1/projects/" + project_id, method="PUT", payload={"status": "running"})
        self.assertEqual(status, 400)
        self.assertEqual(invalid["error"], "invalid_project_status")
        status, invalid_bpm = self.request("/v1/projects/" + project_id, method="PUT", payload={"bpm": 999})
        self.assertEqual(status, 400)
        self.assertEqual(invalid_bpm["error"], "invalid_bpm")

    def test_project_creation_rejects_boolean_bpm(self):
        status, payload = self.request("/v1/projects", method="POST",
                                       payload={"name": "Bad BPM", "bpm": True})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_bpm")

    def test_engine_is_honestly_unavailable_without_local_runtime(self):
        state = module.engine_status()
        self.assertFalse(state["ready"])
        self.assertEqual(state["state"], "independent_composition_and_sample_renderer_prototype")
        self.assertEqual(state["audio_renderer"], "recorded_sample_wav_prototype_available")
        self.assertFalse(state["audio_generation_enabled"])

    def test_no_paid_or_external_fallback_is_advertised(self):
        state = module.engine_status()
        self.assertFalse(state["ready"])
        self.assertIn("public job runner remains disabled", state["message"])

    def test_project_database_persists_and_enforces_limit(self):
        db = module.database()
        try:
            db.execute("INSERT INTO projects (id,name,kind,created_at,updated_at) VALUES (?,?,?,?,?)",
                       ("p1", "Demo", "song", 1, 1))
            db.execute("INSERT INTO projects (id,name,kind,created_at,updated_at) VALUES (?,?,?,?,?)",
                       ("p2", "Demo 2", "beat", 2, 2))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM projects").fetchone()[0], 2)
        finally:
            db.close()

    def test_resource_guard_reports_threshold(self):
        state = module.resource_status()
        self.assertIn("within_limit", state)
        self.assertGreaterEqual(state["free_bytes"], 0)

    def test_resource_status_is_read_only_for_missing_studio_path(self):
        with tempfile.TemporaryDirectory() as parent:
            missing = Path(parent) / "not-created" / "nested"
            with mock.patch.object(module, "ROOT", missing):
                state = module.resource_status()
            self.assertFalse(missing.exists())
            self.assertEqual(state["checked_existing_mount"], parent)
            self.assertIn("within_limit", state)

    def test_resource_status_fails_closed_when_disk_usage_is_unavailable(self):
        with mock.patch.object(module.shutil, "disk_usage", side_effect=OSError("unavailable")):
            state = module.resource_status()
        self.assertIsNone(state["free_bytes"])
        self.assertFalse(state["within_limit"])
        self.assertEqual(state["state"], "unknown")

    def test_preflight_is_offline_and_reports_resources(self):
        report = preflight.inspect()
        self.assertFalse(report["network_accessed"])
        self.assertFalse(report["models_downloaded"])
        self.assertFalse(report["paid_services_used"])
        self.assertIn("cpu_cores", report["system"])
        self.assertIn("free_bytes", report["storage"])

    def test_preflight_does_not_create_studio_directory(self):
        with tempfile.TemporaryDirectory() as parent:
            missing = Path(parent) / "not-created" / "nested"
            with mock.patch.object(preflight, "ROOT", missing), \
                 mock.patch.object(preflight, "detect_gpu", return_value={"detected": False}):
                report = preflight.inspect()
            self.assertFalse(missing.exists())
            self.assertFalse(report["network_accessed"])
            self.assertEqual(report["storage"]["checked_existing_mount"], parent)

    def test_project_creation_rejects_boolean_bpm_on_all_write_paths(self):
        status, payload = self.request("/v1/projects", method="POST",
                                       payload={"name": "Bad BPM", "bpm": True})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_bpm")

    def test_request_size_cap_is_defined(self):
        self.assertEqual(module.MAX_BODY, 64 * 1024)



    def test_curated_lexical_stress_adds_dynamic_accent_without_changing_notes(self):
        from mehran_music_core import _apply_lexical_stress_emphasis
        source = [
            {"stress_role": "lexically_stressed", "stress_confidence": "curated",
             "dynamics_velocity": 76, "tick_start": 480, "tick_end": 960},
            {"stress_role": "unstressed", "stress_confidence": "curated",
             "dynamics_velocity": 70, "tick_start": 960, "tick_end": 1440},
            {"stress_role": "unknown", "stress_confidence": "unknown",
             "dynamics_velocity": 72, "tick_start": 1440, "tick_end": 1920},
        ]
        result = _apply_lexical_stress_emphasis(source)
        self.assertEqual(result[0]["dynamics_velocity"], 84)
        self.assertEqual(result[0]["base_dynamics_velocity"], 76)
        self.assertEqual(result[0]["prosodic_emphasis"], "curated_lexical_stress")
        self.assertEqual(result[1]["dynamics_velocity"], 70)
        self.assertEqual(result[1]["prosodic_emphasis"], "unstressed")
        self.assertEqual(result[2]["dynamics_velocity"], 72)
        self.assertEqual(result[2]["prosodic_emphasis"], "unknown")
        self.assertEqual([(x["tick_start"], x["tick_end"]) for x in result],
                         [(480, 960), (960, 1440), (1440, 1920)])
        self.assertEqual([x["dynamics_velocity"] for x in source], [76, 70, 72])

    def test_persian_prosody_metadata_marks_curated_stress_and_syllable_shape(self):
        plan = module.compose_co_creation_plan(
            chr(10).join(["دلم گرفته", "پرواز سرد"]), title="Prosody metadata",
            genre="pop", mood="sad", target_bpm=82, phrase_count=4,
        )
        first_phrase = plan["composition"]["melody"][0]
        note_map = first_phrase["note_lyric_map"]
        self.assertTrue(note_map)
        stressed = [item for item in note_map
                    if item["stress_role"] == "lexically_stressed"]
        self.assertTrue(stressed)
        self.assertTrue(all(item["stress_confidence"] == "curated"
                            for item in stressed))
        self.assertTrue(any(item["syllable_shape_hint"] in ("open", "closed")
                            for item in note_map))
        self.assertTrue(all(item["shape_confidence"] == "curated_transliteration"
                            for item in note_map
                            if item["syllable_shape_hint"] in ("open", "closed")))
        second_phrase = plan["composition"]["melody"][1]
        unknown_words = [item for item in second_phrase["note_lyric_map"]
                         if item["word"] == "پرواز"]
        self.assertTrue(unknown_words)
        self.assertTrue(all(item["stress_role"] == "unknown"
                            and item["stress_confidence"] == "unknown"
                            and item["syllable_shape_hint"] == "unknown"
                            and item["prosody_method"] == "orthographic_estimate_v1"
                            for item in unknown_words))
        self.assertTrue(all(item["prosody_method"] ==
                            "curated_lyric_pronunciation_lexicon_v1"
                            for item in note_map))



if __name__ == "__main__":
    unittest.main()
