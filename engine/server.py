#!/usr/bin/env python3
"""MEHRAN Music Studio local control plane.

This service intentionally does not call external APIs or download models.
It manages local projects and exposes truthful engine readiness. Bind to
127.0.0.1 by default; expose it to a network only behind an owner-managed
TLS/reverse-proxy and firewall.
"""
from __future__ import annotations

import json
import ipaddress
from contextlib import contextmanager
import os
import secrets
import shutil
import sqlite3
import threading
import time
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(os.environ.get("MEHRAN_STUDIO_HOME", Path.home() / ".mehran-music-studio")).expanduser()
DB_PATH = ROOT / "studio.sqlite3"
MAX_BODY = 64 * 1024
MAX_PROJECTS = int(os.environ.get("MEHRAN_STUDIO_MAX_PROJECTS", "500"))
MIN_FREE_BYTES = int(os.environ.get("MEHRAN_STUDIO_MIN_FREE_BYTES", str(2 * 1024**3)))
HOST = os.environ.get("MEHRAN_STUDIO_HOST", "127.0.0.1")
PORT = int(os.environ.get("MEHRAN_STUDIO_PORT", "8765"))
TOKEN = os.environ.get("MEHRAN_STUDIO_TOKEN", "")
LOCK = threading.Lock()
sys.path.insert(0, str(Path(__file__).resolve().parent))
from mehran_music_core import compose_plan
from midi_renderer import render_midi
from sample_bank import (load_sample_bank, analyze_sample_bank_coverage,
                         analyze_sample_bank_quality, analyze_sample_bank_instrument_health, build_sample_recording_checklist, build_sample_recording_sheet_csv, select_sample)
from sample_renderer import render_composition_to_wav


def database():
    ROOT.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("""CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT '', genre TEXT NOT NULL DEFAULT '',
        mood TEXT NOT NULL DEFAULT '', bpm INTEGER, brief TEXT NOT NULL DEFAULT '',
        lyrics TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )""")
    connection.commit()
    return connection


@contextmanager
def db_session():
    connection = database()
    try:
        yield connection
    except Exception:
        connection.rollback()
        raise
    else:
        connection.commit()
    finally:
        connection.close()


def engine_status():
    return {
        "ready": False,
        "state": "independent_composition_and_sample_renderer_prototype",
        "composition_core": "available",
        "audio_renderer": "recorded_sample_wav_prototype_available",
        "audio_generation_enabled": False,
        "external_model_dependencies": False,
        "message": "The independent MEHRAN composition core and an offline recorded-sample WAV prototype are available. A complete licensed instrument bank, production mixing, mastering, and vocal synthesis are not implemented; the public job runner remains disabled.",
    }


def resource_status():
    # Read-only: inspect the nearest existing ancestor instead of creating
    # directories merely to report storage health.
    disk_path = ROOT
    while not disk_path.exists() and disk_path != disk_path.parent:
        disk_path = disk_path.parent
    try:
        free = shutil.disk_usage(disk_path).free
    except OSError:
        return {"free_bytes": None, "minimum_free_bytes": MIN_FREE_BYTES,
                "within_limit": False, "state": "unknown",
                "checked_existing_mount": str(disk_path)}
    return {"free_bytes": free, "minimum_free_bytes": MIN_FREE_BYTES,
            "within_limit": free >= MIN_FREE_BYTES, "state": "ok",
            "checked_existing_mount": str(disk_path)}


class Handler(BaseHTTPRequestHandler):
    server_version = "MEHRAN-Studio-Control/0.1"

    def log_message(self, *_args):
        return

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        return bool(TOKEN) and secrets.compare_digest(
            self.headers.get("Authorization", ""), "Bearer " + TOKEN
        )

    def do_GET(self):
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})
        path = urlparse(self.path).path
        if path == "/health":
            return self.send_json(200, {
                "service": "mehran-music-studio-control",
                "engine": engine_status(), "resources": resource_status(),
                "external_api_calls": False, "paid_fallback": False
            })
        if path == "/v1/sample-bank/recording-sheet.csv":
            content = build_sample_recording_sheet_csv().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Content-Disposition", 'attachment; filename="mehran-sample-recording-sheet.csv"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(content)
            return
        if path == "/v1/sample-bank/requirements":
            return self.send_json(200, {
                "recording_checklist": build_sample_recording_checklist(),
                "read_only": True,
            })
        if path == "/v1/sample-bank/preview":
            query = parse_qs(urlparse(self.path).query, keep_blank_values=True)
            required = {"instrument", "note", "velocity"}
            allowed = required | {"articulation"}
            if (not required.issubset(query) or not set(query).issubset(allowed)
                    or any(len(values) != 1 for values in query.values())):
                return self.send_json(400, {"error": "invalid_preview_parameters"})
            instrument = query["instrument"][0]
            articulation = query.get("articulation", ["sustain"])[0]
            try:
                note = int(query["note"][0])
                velocity = int(query["velocity"][0])
                if not instrument or len(instrument) > 40 or not instrument.replace("_", "").replace("-", "").isalnum():
                    raise ValueError
                if not isinstance(articulation, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{1,31}", articulation):
                    raise ValueError
                if not 0 <= note <= 127 or not 1 <= velocity <= 127:
                    raise ValueError
            except (ValueError, TypeError):
                return self.send_json(400, {"error": "invalid_preview_parameters"})
            bank_root = Path(os.environ.get("MEHRAN_SAMPLE_BANK", ROOT / "sample_bank")).expanduser()
            try:
                bank = load_sample_bank(bank_root)
                sample = select_sample(bank, instrument, note, velocity, articulation)
                if sample.midi_note != note:
                    return self.send_json(404, {"error": "exact_note_sample_unavailable"})
                size = sample.path.stat().st_size
                if size > 32 * 1024 * 1024:
                    return self.send_json(413, {"error": "sample_preview_too_large"})
                audio = sample.path.read_bytes()
            except (ValueError, OSError):
                return self.send_json(404, {"error": "sample_preview_unavailable"})
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Disposition", "inline; filename=sample-preview.wav")
            self.end_headers()
            self.wfile.write(audio)
            return
        if path == "/v1/sample-bank/diagnostics":
            bank_root = Path(os.environ.get("MEHRAN_SAMPLE_BANK", ROOT / "sample_bank")).expanduser()
            try:
                bank = load_sample_bank(bank_root)
            except ValueError as error:
                return self.send_json(503, {
                    "error": "sample_bank_unavailable",
                    "detail": str(error),
                    "diagnostics_available": False,
                })
            return self.send_json(200, {
                "diagnostics_available": True,
                "coverage": analyze_sample_bank_coverage(bank),
                "signal_quality": analyze_sample_bank_quality(bank),
                "instrument_health": analyze_sample_bank_instrument_health(bank),
                "read_only": True,
            })
        if path == "/v1/projects":
            with db_session() as db:
                rows = db.execute("SELECT * FROM projects ORDER BY updated_at DESC").fetchall()
            return self.send_json(200, {"projects": [dict(row) for row in rows]})
        if path.startswith("/v1/projects/"):
            project_id = path.rsplit("/", 1)[-1]
            if not project_id or len(project_id) > 64:
                return self.send_json(400, {"error": "invalid_project_id"})
            with db_session() as db:
                row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            if row is None:
                return self.send_json(404, {"error": "project_not_found"})
            return self.send_json(200, {"project": dict(row)})
        return self.send_json(404, {"error": "not_found"})

    def do_PUT(self):
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})
        path = urlparse(self.path).path
        if not path.startswith("/v1/projects/"):
            return self.send_json(404, {"error": "not_found"})
        project_id = path.rsplit("/", 1)[-1]
        length = self.headers.get("Content-Length", "")
        if not project_id or len(project_id) > 64:
            return self.send_json(400, {"error": "invalid_project_id"})
        if not length.isdigit() or int(length) > MAX_BODY:
            return self.send_json(413, {"error": "payload_too_large"})
        try:
            payload = json.loads(self.rfile.read(int(length) or 0))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.send_json(400, {"error": "invalid_json"})
        if not isinstance(payload, dict):
            return self.send_json(400, {"error": "invalid_payload"})
        with LOCK, db_session() as db:
            current = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            if current is None:
                return self.send_json(404, {"error": "project_not_found"})
            name = str(payload.get("name", current["name"])).strip()
            kind = str(payload.get("kind", current["kind"])).strip()
            if not name or len(name) > 100 or not kind or len(kind) > 40:
                return self.send_json(400, {"error": "invalid_project_fields"})
            bpm = payload.get("bpm", current["bpm"])
            if bpm is not None and (isinstance(bpm, bool) or not isinstance(bpm, int) or not 20 <= bpm <= 300):
                return self.send_json(400, {"error": "invalid_bpm"})
            values = {
                "language": str(payload.get("language", current["language"]))[:40],
                "genre": str(payload.get("genre", current["genre"]))[:60],
                "mood": str(payload.get("mood", current["mood"]))[:60],
                "brief": str(payload.get("brief", current["brief"]))[:4000],
                "lyrics": str(payload.get("lyrics", current["lyrics"]))[:20000],
                "status": str(payload.get("status", current["status"]))[:20],
            }
            if values["status"] not in ("draft", "ready", "archived"):
                return self.send_json(400, {"error": "invalid_project_status"})
            now = int(time.time())
            db.execute("""UPDATE projects SET name=?, kind=?, language=?, genre=?, mood=?,
                bpm=?, brief=?, lyrics=?, status=?, updated_at=? WHERE id=?""",
                (name, kind, values["language"], values["genre"], values["mood"], bpm,
                 values["brief"], values["lyrics"], values["status"], now, project_id))
            row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return self.send_json(200, {"project": dict(row)})

    def do_DELETE(self):
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})
        path = urlparse(self.path).path
        if not path.startswith("/v1/projects/"):
            return self.send_json(404, {"error": "not_found"})
        project_id = path.rsplit("/", 1)[-1]
        if not project_id or len(project_id) > 64:
            return self.send_json(400, {"error": "invalid_project_id"})
        with LOCK, db_session() as db:
            result = db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            if result.rowcount == 0:
                return self.send_json(404, {"error": "project_not_found"})
        return self.send_json(200, {"deleted": True, "project_id": project_id})

    def do_POST(self):
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})
        path = urlparse(self.path).path
        if path == "/v1/jobs":
            status = engine_status()
            if not status["ready"]:
                return self.send_json(503, {
                    "error": "generation_engine_unavailable",
                    "engine": status,
                    "job_created": False,
                    "charged": False
                })
            return self.send_json(501, {"error": "job_runner_not_implemented", "job_created": False, "charged": False})
        if path not in ("/v1/projects", "/v1/compose", "/v1/compose-audio"):
            return self.send_json(404, {"error": "not_found"})
        length = self.headers.get("Content-Length", "")
        if not length.isdigit() or int(length) > MAX_BODY:
            return self.send_json(413, {"error": "payload_too_large"})
        try:
            payload = json.loads(self.rfile.read(int(length) or 0))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.send_json(400, {"error": "invalid_json"})
        if not isinstance(payload, dict):
            return self.send_json(400, {"error": "invalid_payload"})
        if path == "/v1/compose":
            lyrics = payload.get("lyrics")
            title = payload.get("title", "Untitled")
            genre = payload.get("genre", "pop")
            bpm = payload.get("bpm")
            if not isinstance(lyrics, str) or not lyrics.strip() or len(lyrics) > 20000:
                return self.send_json(400, {"error": "invalid_lyrics"})
            if not isinstance(title, str) or len(title) > 100 or not isinstance(genre, str) or len(genre) > 60:
                return self.send_json(400, {"error": "invalid_composition_fields"})
            if bpm is not None and (isinstance(bpm, bool) or not isinstance(bpm, int) or not 50 <= bpm <= 200):
                return self.send_json(400, {"error": "invalid_bpm"})
            if not resource_status()["within_limit"]:
                return self.send_json(507, {"error": "resource_limit_reached", "composition_created": False})
            try:
                plan = compose_plan(lyrics, title=title, genre=genre, target_bpm=bpm)
                render_id = secrets.token_urlsafe(12)
                render_dir = ROOT / "renders"
                render_dir.mkdir(parents=True, exist_ok=True)
                midi_path = render_dir / (render_id + ".mid")
                midi_info = render_midi(plan, midi_path)
            except (ValueError, OSError) as error:
                return self.send_json(400, {"error": "composition_failed", "detail": str(error)})
            return self.send_json(201, {
                "composition_created": True,
                "audio_rendered": False,
                "plan": plan,
                "midi": {"id": render_id, "format": midi_info["format"],
                         "tracks": midi_info["tracks"], "tempo_bpm": midi_info["tempo_bpm"],
                         "note_events": midi_info["note_events"],
                         "bass_note_events": midi_info["bass_note_events"],
                         "guitar_note_events": midi_info["guitar_note_events"],
                         "piano_note_events": midi_info["piano_note_events"],
                         "drum_hits": midi_info["drum_hits"],
                         "drum_channel": midi_info["drum_channel"],
                         "duration_seconds": midi_info["duration_seconds"],
                         "bytes": midi_info["bytes"], "local_path": str(midi_path)},
                "message": "Composition plan and MIDI file created. Audio rendering is not implemented yet."
            })
        if path == "/v1/compose-audio":
            lyrics = payload.get("lyrics")
            title = payload.get("title", "Untitled")
            genre = payload.get("genre", "pop")
            bpm = payload.get("bpm")
            if not isinstance(lyrics, str) or not lyrics.strip() or len(lyrics) > 20000:
                return self.send_json(400, {"error": "invalid_lyrics"})
            if not isinstance(title, str) or len(title) > 100 or not isinstance(genre, str) or len(genre) > 60:
                return self.send_json(400, {"error": "invalid_composition_fields"})
            if bpm is not None and (isinstance(bpm, bool) or not isinstance(bpm, int) or not 50 <= bpm <= 200):
                return self.send_json(400, {"error": "invalid_bpm"})
            if not resource_status()["within_limit"]:
                return self.send_json(507, {"error": "resource_limit_reached", "audio_rendered": False})
            bank_root = Path(os.environ.get("MEHRAN_SAMPLE_BANK", ROOT / "sample_bank")).expanduser()
            try:
                bank = load_sample_bank(bank_root)
            except ValueError as error:
                return self.send_json(503, {
                    "error": "sample_bank_unavailable",
                    "detail": str(error),
                    "audio_rendered": False,
                    "charged": False,
                })
            try:
                plan = compose_plan(lyrics, title=title, genre=genre, target_bpm=bpm)
                render_id = secrets.token_urlsafe(12)
                render_dir = ROOT / "renders"
                render_dir.mkdir(parents=True, exist_ok=True)
                wav_path = render_dir / (render_id + ".wav")
                audio_info = render_composition_to_wav(plan, bank, wav_path)
            except ValueError as error:
                return self.send_json(422, {
                    "error": "sample_render_failed",
                    "detail": str(error),
                    "audio_rendered": False,
                    "charged": False,
                })
            except OSError:
                return self.send_json(507, {"error": "audio_storage_unavailable", "audio_rendered": False})
            return self.send_json(201, {
                "composition_created": True,
                "audio_rendered": True,
                "plan": plan,
                "audio": {
                    "id": render_id,
                    "format": audio_info["format"],
                    "sample_rate": audio_info["sample_rate"],
                    "channels": audio_info["channels"],
                    "duration_seconds": audio_info["duration_seconds"],
                    "events_rendered": audio_info["events_rendered"],
                    "local_path": str(wav_path),
                },
                "message": "WAV rendered from the configured local recorded-sample bank.",
            })
        name = str(payload.get("name", "")).strip()
        kind = str(payload.get("kind", "song")).strip()
        if not name or len(name) > 100 or len(kind) > 40:
            return self.send_json(400, {"error": "invalid_project_fields"})
        if not resource_status()["within_limit"]:
            return self.send_json(507, {"error": "resource_limit_reached", "project_created": False})
        now = int(time.time())
        project_id = secrets.token_urlsafe(12)
        fields = {
            "language": str(payload.get("language", ""))[:40],
            "genre": str(payload.get("genre", ""))[:60],
            "mood": str(payload.get("mood", ""))[:60],
            "brief": str(payload.get("brief", ""))[:4000],
            "lyrics": str(payload.get("lyrics", ""))[:20000],
        }
        bpm = payload.get("bpm")
        if bpm is not None and (isinstance(bpm, bool) or not isinstance(bpm, int) or not 20 <= bpm <= 300):
            return self.send_json(400, {"error": "invalid_bpm"})
        with LOCK, db_session() as db:
            count = db.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
            if count >= MAX_PROJECTS:
                return self.send_json(429, {"error": "project_limit_reached", "project_created": False})
            db.execute("""INSERT INTO projects
                (id,name,kind,language,genre,mood,bpm,brief,lyrics,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (project_id, name, kind, fields["language"], fields["genre"], fields["mood"],
                 bpm, fields["brief"], fields["lyrics"], now, now))
        return self.send_json(201, {"project": {"id": project_id, "name": name, "kind": kind,
                                                "status": "draft", "created_at": now}})


def validate_server_config(host, port):
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise SystemExit("MEHRAN_STUDIO_HOST must be an IPv4 loopback address such as 127.0.0.1.") from exc
    if address.version != 4 or not address.is_loopback:
        raise SystemExit("MEHRAN Studio may only bind to an IPv4 loopback address. Public/network binds are blocked.")
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise SystemExit("MEHRAN_STUDIO_PORT must be an integer from 1 to 65535.")


def main():
    if not TOKEN:
        raise SystemExit("Set MEHRAN_STUDIO_TOKEN to a long random secret before starting.")
    if len(TOKEN) < 32:
        raise SystemExit("MEHRAN_STUDIO_TOKEN must contain at least 32 characters.")
    validate_server_config(HOST, PORT)
    connection = database()
    connection.close()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"MEHRAN Music Studio control plane listening on http://{HOST}:{PORT}")
    print("Local-only by default. No external API, billing, or paid fallback is configured.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
