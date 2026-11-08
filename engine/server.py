#!/usr/bin/env python3
"""MEHRAN Music Studio local control plane.

This service intentionally does not call external APIs or download models.
It manages local projects and exposes truthful engine readiness. Bind to
127.0.0.1 by default; expose it to a network only behind an owner-managed
TLS/reverse-proxy and firewall.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import sqlite3
import threading
import time
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

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
import model_policy


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


def engine_status():
    models_root = ROOT / "models"
    manifest = models_root / "runtime.json"
    if not manifest.is_file():
        return {"ready": False, "state": "not_installed",
                "message": "No locally installed model runtime. No generation can be started."}
    validation = model_policy.validate_manifest(models_root, manifest)
    if not validation["valid"]:
        return {"ready": False, "state": "invalid_manifest",
                "message": validation["message"]}
    return {"ready": False, "state": "model_verified_runner_not_integrated",
            "model_id": validation["model_id"], "license": validation["license"],
            "verified_artifacts": validation["verified_artifacts"],
            "message": "Local model files and approval are verified, but the inference runner is not integrated. Generation remains disabled."}


def resource_status():
    ROOT.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(ROOT).free
    return {"free_bytes": free, "minimum_free_bytes": MIN_FREE_BYTES,
            "within_limit": free >= MIN_FREE_BYTES}


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
        if path == "/v1/projects":
            with database() as db:
                rows = db.execute("SELECT * FROM projects ORDER BY updated_at DESC").fetchall()
            return self.send_json(200, {"projects": [dict(row) for row in rows]})
        return self.send_json(404, {"error": "not_found"})

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
        if path != "/v1/projects":
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
        if bpm is not None and (not isinstance(bpm, int) or not 20 <= bpm <= 300):
            return self.send_json(400, {"error": "invalid_bpm"})
        with LOCK, database() as db:
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


def main():
    if not TOKEN:
        raise SystemExit("Set MEHRAN_STUDIO_TOKEN to a long random secret before starting.")
    if len(TOKEN) < 32:
        raise SystemExit("MEHRAN_STUDIO_TOKEN must contain at least 32 characters.")
    with database():
        pass
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
