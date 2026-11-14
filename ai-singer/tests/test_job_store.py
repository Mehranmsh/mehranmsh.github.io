import os
import tempfile
import time
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

    def test_worker_cannot_claim_before_model_is_ready(self):
        record, token = job_store.create_job("project-not-ready", {"lyrics": "سلام"})
        self.assertIsNone(job_store.claim_next_job("worker-a", model_ready=False))
        self.assertEqual(job_store.get_job(record["job_id"], token)["status"], "blocked_model_unavailable")

    def test_atomic_lease_and_worker_ownership(self):
        record, _token = job_store.create_job("project-queue", {"lyrics": "سلام"})
        with job_store._connect() as db:
            db.execute(
                "UPDATE singing_jobs SET status = 'queued', priority = 4 WHERE job_id = ?",
                (record["job_id"],),
            )
        claimed = job_store.claim_next_job("worker-a", model_ready=True, lease_seconds=30)
        self.assertEqual(claimed["status"], "processing")
        self.assertEqual(claimed["attempt_count"], 1)
        self.assertFalse(job_store.renew_job_lease(record["job_id"], "worker-b"))
        self.assertTrue(job_store.renew_job_lease(record["job_id"], "worker-a"))
        self.assertTrue(job_store.finish_job(record["job_id"], "worker-a", success=False, error_code="temporary_error"))
        with job_store._connect() as db:
            row = db.execute("SELECT status, attempt_count FROM singing_jobs WHERE job_id = ?", (record["job_id"],)).fetchone()
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["attempt_count"], 1)

    def test_expired_lease_is_reclaimed_and_attempt_counted(self):
        record, _token = job_store.create_job("project-expiry", {"lyrics": "سلام"})
        with job_store._connect() as db:
            db.execute(
                """UPDATE singing_jobs SET status = 'processing', worker_id = 'dead-worker',
                   lease_until = ?, attempt_count = 1, max_attempts = 2 WHERE job_id = ?""",
                (time.time() - 1, record["job_id"]),
            )
        claimed = job_store.claim_next_job("worker-recovery", model_ready=True, lease_seconds=30)
        self.assertEqual(claimed["worker_id"], "worker-recovery")
        self.assertEqual(claimed["attempt_count"], 2)

    def test_unknown_job_is_not_disclosed(self):
        self.assertIsNone(job_store.get_job("unknown", "secret"))


if __name__ == "__main__":
    unittest.main()
