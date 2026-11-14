import unittest

from server import RATE_LIMITS, _allow_request


class ApiRateLimitTests(unittest.TestCase):
    def test_alignment_limit_is_enforced_per_ip_and_route(self):
        path = "/v1/jobs/align"
        limit = RATE_LIMITS[path]
        for index in range(limit):
            self.assertTrue(_allow_request("192.0.2.10", path, 100.0 + index / 100))
        self.assertFalse(_allow_request("192.0.2.10", path, 101.0))
        self.assertTrue(_allow_request("192.0.2.11", path, 101.0))

    def test_window_expires_old_requests(self):
        path = "/v1/jobs/align"
        limit = RATE_LIMITS[path]
        for index in range(limit):
            self.assertTrue(_allow_request("192.0.2.20", path, 200.0 + index / 100))
        self.assertTrue(_allow_request("192.0.2.20", path, 261.0))


if __name__ == "__main__":
    unittest.main()
