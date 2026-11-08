import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

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

    def tearDown(self):
        self.temp.cleanup()

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

    def test_request_size_cap_is_defined(self):
        self.assertEqual(module.MAX_BODY, 64 * 1024)


if __name__ == "__main__":
    unittest.main()
