#!/usr/bin/env python3
"""Fast, dependency-free syntax checks for the MEHRAN MSH web app."""
from html.parser import HTMLParser
from pathlib import Path
import subprocess
import tempfile
import sys

ROOT = Path(__file__).resolve().parents[1]
HTML_FILE = ROOT / "index.html"
WORKER_FILE = ROOT / "worker.js"

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
    for path in (HTML_FILE, WORKER_FILE):
        if not path.is_file():
            raise SystemExit(f"Required project file is missing: {path.name}")

    print("1/3 Checking Cloudflare Worker JavaScript syntax...")
    run_node_check(WORKER_FILE)

    print("2/3 Parsing app HTML and checking inline JavaScript...")
    parser = InlineScripts()
    parser.feed(HTML_FILE.read_text(encoding="utf-8"))
    parser.close()
    checked = 0
    with tempfile.TemporaryDirectory() as temp:
        for index, item in enumerate(parser.scripts, start=1):
            if item["external"] or not item["is_js"]:
                continue
            source = "".join(item["parts"]).strip()
            if not source:
                continue
            candidate = Path(temp) / f"inline-script-{index}.js"
            candidate.write_text(source, encoding="utf-8")
            run_node_check(candidate)
            checked += 1

    if checked == 0:
        raise SystemExit("No inline JavaScript blocks were found; refusing a false-green check.")

    print(f"3/3 Passed: Worker syntax + {checked} inline JavaScript block(s).")
    print("Note: these checks do not replace live Pi Browser, database, or security integration tests.")

if __name__ == "__main__":
    main()
