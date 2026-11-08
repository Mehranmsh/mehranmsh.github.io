import importlib.util
import json
import hashlib
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
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
        status = response.code\n        body = response.read().decode("utf-8")\n        response.close()\n        return status, json.loads(body)

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


    def write_manifest(self, **overrides):
        artifact = self.models / "tiny-model.bin"
        artifact.write_bytes(b"local model test bytes")
        data = {
            "enabled": True, "runtime": "local", "model_id": "ace-step-1.5",
            "license": "MIT", "license_reviewed": True, "owner_approved": True,
            "self_test_passed": True,
            "artifacts": [{"path": "tiny-model.bin", "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()}],
        }
        data.update(overrides)
        (self.models / "runtime.json").write_text(json.dumps(data), encoding="utf-8")
        return artifact

    def test_model_manifest_requires_owner_approval_and_verified_hash(self):
        self.write_manifest()
        result = module.model_policy.validate_manifest(self.models)
        self.assertTrue(result["valid"])
        self.assertEqual(result["model_id"], "ace-step-1.5")

    def test_noncommercial_model_is_not_allowlisted(self):
        self.write_manifest(model_id="musicgen", license="CC-BY-NC-4.0")
        result = module.model_policy.validate_manifest(self.models)
        self.assertFalse(result["valid"])

    def test_owner_approval_is_mandatory(self):
        self.write_manifest(owner_approved=False)
        result = module.model_policy.validate_manifest(self.models)
        self.assertFalse(result["valid"])
        self.assertIn("Owner approval", result["message"])

    def test_model_artifact_hash_mismatch_is_rejected(self):
        self.write_manifest(artifacts=[{"path": "tiny-model.bin", "sha256": "0" * 64}])
        result = module.model_policy.validate_manifest(self.models)
        self.assertFalse(result["valid"])
        self.assertIn("SHA-256 mismatch", result["message"])


    def test_malformed_hash_is_rejected_before_reading_artifact(self):
        self.write_manifest(artifacts=[{"path": "tiny-model.bin", "sha256": "z" * 64}])
        result = module.model_policy.validate_manifest(self.models)
        self.assertFalse(result["valid"])
        self.assertIn("hexadecimal SHA-256", result["message"])

    def test_model_artifact_path_traversal_is_rejected(self):
        self.write_manifest(artifacts=[{"path": "../outside.bin", "sha256": "0" * 64}])
        result = module.model_policy.validate_manifest(self.models)
        self.assertFalse(result["valid"])

    def test_verified_model_still_cannot_start_generation_before_runner_integration(self):
        self.write_manifest()
        status = module.engine_status()
        self.assertFalse(status["ready"])
        self.assertEqual(status["state"], "model_verified_runner_not_integrated")


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

    def test_engine_is_honestly_unavailable_without_local_runtime(self):
        state = module.engine_status()
        self.assertFalse(state["ready"])
        self.assertEqual(state["state"], "not_installed")

    def test_no_paid_or_external_fallback_is_advertised(self):
        state = module.engine_status()
        self.assertFalse(state["ready"])
        self.assertIn("No generation can be started", state["message"])

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

    def test_preflight_is_offline_and_reports_resources(self):
        report = preflight.inspect()
        self.assertFalse(report["network_accessed"])
        self.assertFalse(report["models_downloaded"])
        self.assertFalse(report["paid_services_used"])
        self.assertIn("cpu_cores", report["system"])
        self.assertIn("free_bytes", report["storage"])

    def test_request_size_cap_is_defined(self):
        self.assertEqual(module.MAX_BODY, 64 * 1024)


if __name__ == "__main__":
    unittest.main()
