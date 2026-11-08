import threading
import unittest

from resource_guard import ResourceGuard, ResourceSnapshot


class ResourceGuardTests(unittest.TestCase):
    def setUp(self):
        self.guard = ResourceGuard()
        self.snapshot = ResourceSnapshot(free_bytes=8 * 1024**3)

    def reserve(self, key="request-key-000001", **kwargs):
        args = {
            "snapshot": self.snapshot,
            "engine_ready": True,
            "idempotency_key": key,
            "duration_seconds": 180,
            "batch_size": 1,
        }
        args.update(kwargs)
        return self.guard.reserve(**args)

    def test_accepts_one_safe_reservation_without_starting_model(self):
        decision = self.reserve()
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.code, "reserved")
        self.assertIsNotNone(decision.reservation_id)
        self.assertEqual(self.guard.status()["active_jobs"], 1)

    def test_engine_must_be_verified_ready(self):
        decision = self.reserve(engine_ready=False)
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "engine_not_ready")

    def test_unknown_or_low_disk_space_fails_closed(self):
        cases = [
            (ResourceSnapshot(free_bytes=None), "disk_space_unknown"),
            (ResourceSnapshot(free_bytes=100, disk_reserve_bytes=200), "disk_reserve_reached"),
            (ResourceSnapshot(free_bytes=True), "disk_space_unknown"),
        ]
        for snapshot, code in cases:
            with self.subTest(code=code):
                decision = self.reserve(snapshot=snapshot)
                self.assertFalse(decision.allowed)
                self.assertEqual(decision.code, code)

    def test_active_job_blocks_another_reservation(self):
        first = self.reserve()
        second = self.reserve(key="request-key-000002")
        self.assertTrue(first.allowed)
        self.assertFalse(second.allowed)
        self.assertEqual(second.code, "concurrency_limit")

    def test_duplicate_key_is_rejected_even_after_release(self):
        first = self.reserve()
        self.assertTrue(self.guard.release(first.reservation_id))
        second = self.reserve()
        self.assertFalse(second.allowed)
        self.assertEqual(second.code, "duplicate_request")

    def test_only_single_output_and_bounded_duration(self):
        for kwargs, code in [
            ({"batch_size": 2}, "batch_limit"),
            ({"batch_size": True}, "batch_limit"),
            ({"duration_seconds": 601}, "duration_limit"),
            ({"duration_seconds": True}, "duration_limit"),
            ({"duration_seconds": 9}, "duration_limit"),
        ]:
            with self.subTest(kwargs=kwargs):
                decision = self.reserve(key="request-key-" + str(len(str(kwargs))).zfill(6), **kwargs)
                self.assertFalse(decision.allowed)
                self.assertEqual(decision.code, code)

    def test_invalid_idempotency_key_is_rejected(self):
        decision = self.reserve(key="short")
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "invalid_idempotency_key")

    def test_release_requires_matching_reservation(self):
        first = self.reserve()
        self.assertFalse(self.guard.release("not-the-reservation"))
        self.assertEqual(self.guard.status()["active_jobs"], 1)
        self.assertTrue(self.guard.release(first.reservation_id))
        self.assertFalse(self.guard.release(first.reservation_id))
        self.assertEqual(self.guard.status()["active_jobs"], 0)

    def test_concurrent_reservations_never_exceed_one(self):
        barrier = threading.Barrier(8)
        results = []
        result_lock = threading.Lock()

        def attempt(index):
            barrier.wait()
            result = self.reserve(key=f"parallel-request-{index:04d}")
            with result_lock:
                results.append(result)

        threads = [threading.Thread(target=attempt, args=(i,)) for i in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=2)
        self.assertEqual(sum(result.allowed for result in results), 1)
        self.assertEqual(self.guard.status()["active_jobs"], 1)


if __name__ == "__main__":
    unittest.main()
