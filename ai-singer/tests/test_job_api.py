import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException
from starlette.requests import Request

import job_store
from server import submit_job, read_job_status, stop_job


def request_with_token(token=""):
    return Request({
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/",
        "raw_path": b"/",
        "query_string": b"",
        "headers": [(b"x-job-token", token.encode())],
        "client": ("127.0.0.1", 1234),
        "server": ("test", 80),
    })


def valid_job():
    return {
        "schema": "mehran.svs.job.v1",
        "project": {"id": "queue-project", "language": "Persian", "lyrics": "سلام", "tempo": 100},
        "singer": {},
        "melody": {
            "source": "project_pattern",
            "noteEvents": [{"note": "C4", "startStep": 0, "lengthSteps": 4, "velocity": 80}],
        },
        "render": {},
        "engine": {},
    }


class JobApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        job_store.DB_PATH = Path(self.temp.name) / "jobs.sqlite3"
        job_store.initialize_job_store()

    def tearDown(self):
        self.temp.cleanup()

    def test_submit_and_read_private_job(self):
        created = submit_job(valid_job())
        self.assertEqual(created["status"], "blocked_model_unavailable")
        self.assertFalse(created["accepted_for_generation"])
        result = read_job_status(created["job_id"], request_with_token(created["access_token"]))
        self.assertEqual(result["job_id"], created["job_id"])
        self.assertFalse(result["audio_generated"])

    def test_wrong_token_is_hidden_as_not_found(self):
        created = submit_job(valid_job())
        with self.assertRaises(HTTPException) as error:
            read_job_status(created["job_id"], request_with_token("not-the-token"))
        self.assertEqual(error.exception.status_code, 404)

    def test_cancel_job(self):
        created = submit_job(valid_job())
        result = stop_job(created["job_id"], request_with_token(created["access_token"]))
        self.assertEqual(result["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
