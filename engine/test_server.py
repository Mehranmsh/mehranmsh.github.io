import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

PREFLIGHT_PATH = Path(__file__).with_name("preflight.py")\npreflight_spec = importlib.util.spec_from_file_location("mehran_studio_preflight", PREFLIGHT_PATH)\npreflight = importlib.util.module_from_spec(preflight_spec)\npreflight_spec.loader.exec_module(preflight)\n\nMODULE_PATH = Path(__file__).with_name("server.py")
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
        return response.code, json.loads(response.read().decode("utf-8"))

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

    def test_authenticated_project_creation_persists(self):
        status, payload = self.request("/v1/projects", method="POST", payload={"name": "Local Demo", "kind": "song"})
        self.assertEqual(status, 201)
        self.assertEqual(payload["project"]["status"], "draft")
        status, listing = self.request("/v1/projects")
        self.assertEqual(status, 200)
        self.assertEqual(len(listing["projects"]), 1)
        self.assertEqual(listing["projects"][0]["name"], "Local Demo")

    def test_engine_is_honestly_unavailable_without_local_runtime(self):
        state = module.engine_status()
        self.assertFalse(state["ready"])
        self.assertEqual(state["state"], "not_installed")

    def test_no_paid_or_external_fallback_is_advertised(self):
        state = module.engine_status()
        self.assertFalse(state["ready"])
        self.assertIn("No generation can be started", state["message"])

    def test_project_database_persists_and_enforces_limit(self):
        with module.database() as db:
            db.execute("INSERT INTO projects (id,name,kind,created_at,updated_at) VALUES (?,?,?,?,?)",
                       ("p1", "Demo", "song", 1, 1))
            db.execute("INSERT INTO projects (id,name,kind,created_at,updated_at) VALUES (?,?,?,?,?)",
                       ("p2", "Demo 2", "beat", 2, 2))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM projects").fetchone()[0], 2)

    def test_resource_guard_reports_threshold(self):
        state = module.resource_status()
        self.assertIn("within_limit", state)
        self.assertGreaterEqual(state["free_bytes"], 0)

    def test_preflight_is_offline_and_reports_resources(self):\n        report = preflight.inspect()\n        self.assertFalse(report["network_accessed"])\n        self.assertFalse(report["models_downloaded"])\n        self.assertFalse(report["paid_services_used"])\n        self.assertIn("cpu_cores", report["system"])\n        self.assertIn("free_bytes", report["storage"])\n\n    def test_request_size_cap_is_defined(self):
        self.assertEqual(module.MAX_BODY, 64 * 1024)


if __name__ == "__main__":
    unittest.main()
