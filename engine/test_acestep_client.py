import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from acestep_client import ACEstepLocalClient, LocalModelError


class FakeACEHandler(BaseHTTPRequestHandler):
    last_path = None
    last_body = None
    last_headers = None
    response_status = 200
    response_body = {"code": 200, "error": None, "data": {"task_id": "task_12345678", "status": "queued"}}

    def log_message(self, *_args):
        return

    def do_GET(self):
        FakeACEHandler.last_path = self.path
        FakeACEHandler.last_headers = dict(self.headers)
        body = json.dumps(FakeACEHandler.response_body).encode()
        self.send_response(FakeACEHandler.response_status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        FakeACEHandler.last_path = self.path
        FakeACEHandler.last_headers = dict(self.headers)
        FakeACEHandler.last_body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        body = json.dumps(FakeACEHandler.response_body).encode()
        self.send_response(FakeACEHandler.response_status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ACEstepClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeACEHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        FakeACEHandler.response_status = 200
        FakeACEHandler.response_body = {"code": 200, "error": None, "data": {"task_id": "task_12345678", "status": "queued"}}
        FakeACEHandler.last_body = None
        FakeACEHandler.last_path = None

    def test_implicit_local_port_defaults_to_ace_step_api_port(self):
        client = ACEstepLocalClient("http://127.0.0.1")
        self.assertEqual(client.port, 8001)

    def test_explicit_zero_port_is_rejected(self):
        with self.assertRaises(ValueError):
            ACEstepLocalClient("http://127.0.0.1:0")

    def test_public_host_is_rejected(self):
        with self.assertRaises(ValueError):
            ACEstepLocalClient("http://example.com:8001")

    def test_dns_hostnames_are_rejected_even_when_named_localhost(self):
        with self.assertRaisesRegex(ValueError, "DNS hostnames are blocked"):
            ACEstepLocalClient("http://localhost:8001")

    def test_private_lan_addresses_are_rejected(self):
        with self.assertRaises(ValueError):
            ACEstepLocalClient("http://192.168.1.10:8001")

    def test_remote_scheme_and_path_are_rejected(self):
        with self.assertRaises(ValueError):
            ACEstepLocalClient("https://127.0.0.1:8001")
        with self.assertRaises(ValueError):
            ACEstepLocalClient(self.url + "/prefix")

    def test_song_submission_is_local_and_limits_batch_size(self):
        client = ACEstepLocalClient(self.url, api_key="local-secret")
        result = client.submit_song("ambient piano", "Verse", language="en", duration=90, bpm=82)
        self.assertEqual(result["task_id"], "task_12345678")
        self.assertEqual(FakeACEHandler.last_path, "/release_task")
        self.assertEqual(FakeACEHandler.last_body["batch_size"], 1)
        self.assertEqual(FakeACEHandler.last_body["bpm"], 82)
        self.assertEqual(FakeACEHandler.last_headers["Authorization"], "Bearer local-secret")

    def test_invalid_generation_limits_are_rejected_before_network(self):
        client = ACEstepLocalClient(self.url)
        with self.assertRaises(ValueError):
            client.submit_song("prompt", duration=601)
        with self.assertRaises(ValueError):
            client.submit_song("prompt", bpm=301)
        self.assertIsNone(FakeACEHandler.last_path)

    def test_non_text_prompts_and_lyrics_are_rejected_before_network(self):
        client = ACEstepLocalClient(self.url)
        with self.assertRaisesRegex(ValueError, "must be text"):
            client.submit_song(None)
        with self.assertRaisesRegex(ValueError, "must be text"):
            client.submit_song("valid prompt", lyrics=["not", "text"])
        self.assertIsNone(FakeACEHandler.last_path)

    def test_redirects_and_unsuccessful_wrappers_are_rejected(self):
        client = ACEstepLocalClient(self.url)
        FakeACEHandler.response_status = 302
        with self.assertRaises(LocalModelError):
            client.health()
        FakeACEHandler.response_status = 200
        FakeACEHandler.response_body = {"code": 500, "error": "bad", "data": None}
        with self.assertRaises(LocalModelError):
            client.health()

    def test_query_task_ids_are_validated(self):
        client = ACEstepLocalClient(self.url)
        with self.assertRaises(ValueError):
            client.query_tasks(["../../outside"])
        self.assertIsNone(FakeACEHandler.last_path)


    def test_oversized_local_model_response_is_rejected(self):
        client = ACEstepLocalClient(self.url, max_response_bytes=1024)
        FakeACEHandler.response_body = {
            "code": 200, "error": None, "data": {"payload": "x" * 2048}
        }
        with self.assertRaisesRegex(LocalModelError, "exceeded the configured size limit"):
            client.health()

    def test_non_object_local_model_response_is_rejected(self):
        client = ACEstepLocalClient(self.url)
        FakeACEHandler.response_body = ["unexpected", "list"]
        with self.assertRaisesRegex(LocalModelError, "unsuccessful operation"):
            client.health()

    def test_unsupported_local_model_endpoint_is_rejected_before_network(self):
        client = ACEstepLocalClient(self.url)
        with self.assertRaises(ValueError):
            client._request("GET", "/admin")
        self.assertIsNone(FakeACEHandler.last_path)

    def test_api_key_is_not_sent_when_not_configured(self):
        client = ACEstepLocalClient(self.url)
        client.health()
        self.assertNotIn("Authorization", FakeACEHandler.last_headers)


if __name__ == "__main__":
    unittest.main()
