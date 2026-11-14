import os
import tempfile
import unittest
from pathlib import Path

import job_store


class JobStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        job_store.DB_PATH = Path(self.temp.name) / "jobs.sqlite3"
        job_store.initialize_job_store()

    def tearDown(self):
        self.temp.cleanup()

    def test_create_and_authorized_read(self):
        record, token = job_store.create_job("project-a", {"lyrics": "سلام"})
        self.assertEqual(record["status"], "blocked_model_unavailable")
        self.assertEqual(job_store.get_job(record["job_id"], token)["project_id"], "project-a")
        events = job_store.get_job_events(record["job_id"], token)
        self.assertEqual([event["event_type"] for event in events], ["created"])
        self.assertIsNone(job_store.get_job_events(record["job_id"], "wrong-token"))
        self.assertIsNone(job_store.get_job(record["job_id"], "wrong-token"))

    def test_cancel_job(self):
        record, token = job_store.create_job("project-b", {"notes": []})
        cancelled = job_store.cancel_job(record["job_id"], token)
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertTrue(cancelled["cancellation_requested"])
        events = job_store.get_job_events(record["job_id"], token)
        self.assertEqual([event["event_type"] for event in events], ["created", "cancelled"])

    def test_unknown_job_is_not_disclosed(self):
        self.assertIsNone(job_store.get_job("unknown", "secret"))


if __name__ == "__main__":
    unittest.main()
