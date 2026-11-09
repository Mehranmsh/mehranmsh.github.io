#!/usr/bin/env python3
"""Fast, dependency-free syntax checks for the MEHRAN MSH web app."""
from html.parser import HTMLParser
from pathlib import Path
import subprocess
import tempfile
import sys

ROOT = Path(__file__).resolve().parents[1]
HTML_FILES = [ROOT / "index.html", ROOT / "music-studio.html"]
WORKER_FILE = ROOT / "worker.js"
ENGINE_FILE = ROOT / "engine" / "server.py"

class InlineScripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.current = None
        self.scripts = []
    def handle_starttag(self, tag, attrs):
        if tag.lower() == "script":
            attrs = dict(attrs)
            src = attrs.get("src")
            kind = (attrs.get("type") or "").strip().lower()
            is_js = not kind or kind in ("module", "text/javascript", "application/javascript")
            self.current = {"external": bool(src), "is_js": is_js, "parts": []}
    def handle_data(self, data):
        if self.current is not None:
            self.current["parts"].append(data)
    def handle_endtag(self, tag):
        if tag.lower() == "script" and self.current is not None:
            self.scripts.append(self.current)
            self.current = None

def run_node_check(path):
    result = subprocess.run(["node", "--check", str(path)], text=True, capture_output=True)
    if result.returncode:
        print(result.stderr.strip() or result.stdout.strip())
        raise SystemExit(result.returncode)

def main():
    for path in (*HTML_FILES, WORKER_FILE):
        if not path.is_file():
            raise SystemExit(f"Required project file is missing: {path.name}")

    print("1/3 Checking Cloudflare Worker JavaScript syntax...")
    run_node_check(WORKER_FILE)

    print("2/3 Parsing app HTML and checking inline JavaScript...")
    checked = 0
    with tempfile.TemporaryDirectory() as temp:
        for html_file in HTML_FILES:
            parser = InlineScripts()
            parser.feed(html_file.read_text(encoding="utf-8"))
            parser.close()
            file_checked = 0
            for index, item in enumerate(parser.scripts, start=1):
                if item["external"] or not item["is_js"]:
                    continue
                source = "".join(item["parts"]).strip()
                if not source:
                    continue
                candidate = Path(temp) / f"{html_file.stem}-inline-script-{index}.js"
                candidate.write_text(source, encoding="utf-8")
                run_node_check(candidate)
                checked += 1
                file_checked += 1
            if file_checked == 0:
                raise SystemExit(f"No inline JavaScript blocks were found in {html_file.name}; refusing a false-green check.")

    print("3/4 Checking Music Studio user-facing safety and workflow controls...")
    studio = (ROOT / "music-studio.html").read_text(encoding="utf-8")
    required_studio_markers = [
        'id="lyricsEditor"', 'id="lyricsProject"', 'id="saveLyrics"',
        'id="exportLyrics"', 'data-lyric-section="[Chorus]"',
        'id="exportBackup"', 'id="importBackup"', 'id="backupFile"',
        'mehran-music-studio-backup', 'Could not save: browser storage is full or unavailable',
        'Tempo must be between 40 and 220 BPM', 'id="vocalProject"', 'id="singerName"',
        'id="addSinger"', 'id="vocalCast"', 'data-remove-singer', 'Up to 8 singer profiles per project',
        'singers:Array.isArray(p.singers)'
    ]
    missing = [marker for marker in required_studio_markers if marker not in studio]
    if missing:
        raise SystemExit("Music Studio safety/workflow markers missing: " + ", ".join(missing))
    if 'if(!save()){projects.pop();return;}' not in studio:
        raise SystemExit("Music Studio must not report a new project saved when local storage fails.")
    if 'if(!save()){Object.assign(p,previous);return;}' not in studio:
        raise SystemExit("Music Studio must restore the prior project when an update cannot be saved.")
    if 'if(!save()){Object.assign(p,previous);$("lyricsSaveState").textContent="Save failed";return;}' not in studio:
        raise SystemExit("Lyrics Lab must report storage failure and restore unsaved project data.")
    if 'function addSinger()' not in studio or 'if(p.singers.length>=8)' not in studio:
        raise SystemExit("Vocal Lab must validate singer profiles and enforce the 8-singer project limit.")
    if 'if(!save()){p.singers.pop();p.updated=previousUpdated;return;}' not in studio:
        raise SystemExit("Vocal Lab must roll back singer changes when local storage fails.")
    for marker in [r'split(/\s+/)', r'/^\d{2,3}$/', r'endsWith("\n")', r'section+"\n"']:
        if marker not in studio:
            raise SystemExit("Music Studio lyric/tempo input handling is missing: " + marker)



    print("3/4 Checking SOCIAL account deletion and re-authentication controls...")
    app = (ROOT / "index.html").read_text(encoding="utf-8")
    required_social_deletion_markers = [
        'id="socialDeletePassword"', 'id="socialDeleteAccountBtn"',
        'Permanently delete my account', 'socialFirebaseReauthenticate',
        'reauthenticateWithCredential', 'socialFirebaseDeleteIdentity',
        'fetch(SOCIAL_API+"/account"', 'Account data cleanup could not be completed'
    ]
    missing = [marker for marker in required_social_deletion_markers if marker not in app]
    if missing:
        raise SystemExit("SOCIAL account deletion UI markers missing: " + ", ".join(missing))
    worker = (ROOT / "worker.js").read_text(encoding="utf-8")
    if "rapidfileRequest(env, `/files/${encodeURIComponent(upload.id)}`, { method: \"DELETE\" })" not in worker:
        raise SystemExit("SOCIAL account deletion must remove uploaded files from external storage.")
    if "DELETE FROM social_users WHERE id=?" not in worker or "identity.localId === row.firebase_uid" not in worker:
        raise SystemExit("SOCIAL account deletion must remove the user row only after provider re-authentication.")

    print("3/4 Checking the self-hosted Music Studio control-plane Python syntax...")
    import py_compile
    py_compile.compile(str(ENGINE_FILE), doraise=True)

    print(f"4/4 Passed: Worker syntax + {checked} inline JavaScript block(s) across {len(HTML_FILES)} HTML app(s), and local engine syntax.")
    print("Note: these checks do not replace live Pi Browser, database, or security integration tests.")

if __name__ == "__main__":
    main()
