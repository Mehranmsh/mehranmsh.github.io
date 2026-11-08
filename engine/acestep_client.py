"""Local-only HTTP client for the self-hosted ACE-Step API.

This module never accepts a public hostname, follows redirects, or calls a
hosted inference provider. It is an adapter only; the job runner remains
disabled until the model and hardware have passed local acceptance tests.
"""
from __future__ import annotations

import http.client
import ipaddress
import json
import re
import socket
from urllib.parse import urlsplit


class LocalModelError(RuntimeError):
    pass


class ACEstepLocalClient:
    def __init__(self, base_url="http://127.0.0.1:8001", api_key="", timeout=10, max_response_bytes=2 * 1024 * 1024):
        parsed = urlsplit(base_url)
        if parsed.scheme != "http" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("ACE-Step must use a plain local HTTP endpoint without credentials.")
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise ValueError("ACE-Step base URL cannot contain a path, query or fragment.")
        host = parsed.hostname.lower()
        if host != "localhost":
            try:
                if not ipaddress.ip_address(host).is_loopback:
                    raise ValueError("Only loopback ACE-Step endpoints are allowed.")
            except ValueError as exc:
                if "Only loopback" in str(exc):
                    raise
                raise ValueError("Only localhost or a loopback IP address is allowed.") from exc
        else:
            addresses = socket.getaddrinfo(host, parsed.port or 8001, type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(item[4][0]).is_loopback for item in addresses):
                raise ValueError("localhost resolved to a non-loopback address.")
        self.host = host
        self.port = parsed.port if parsed.port is not None else 8001
        if not 1 <= self.port <= 65535:
            raise ValueError("Invalid local ACE-Step port.")
        self.api_key = api_key
        self.timeout = max(1, min(int(timeout), 30))
        self.max_response_bytes = max(1024, min(int(max_response_bytes), 8 * 1024 * 1024))

    def _request(self, method, path, payload=None):
        if path not in ("/health", "/v1/models", "/release_task", "/query_result"):
            raise ValueError("Unsupported ACE-Step endpoint.")
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Accept": "application/json", "Connection": "close"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        connection = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            if 300 <= response.status < 400:
                raise LocalModelError("Redirects from the local model server are blocked.")
            raw = response.read(self.max_response_bytes + 1)
            if len(raw) > self.max_response_bytes:
                raise LocalModelError("Local model response exceeded the configured size limit.")
            if response.status < 200 or response.status >= 300:
                raise LocalModelError(f"Local model server returned HTTP {response.status}.")
            try:
                data = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise LocalModelError("Local model server returned invalid JSON.") from exc
            if not isinstance(data, dict) or data.get("code") != 200 or data.get("error") not in (None, ""):
                raise LocalModelError("Local model server reported an unsuccessful operation.")
            return data.get("data")
        finally:
            connection.close()

    def health(self):
        return self._request("GET", "/health")

    def list_models(self):
        result = self._request("GET", "/v1/models")
        if not isinstance(result, dict) or not isinstance(result.get("models"), list):
            raise LocalModelError("Unexpected local model list response.")
        return result["models"]

    def submit_song(self, prompt, lyrics="", language="en", duration=180, bpm=None, thinking=False, audio_format="wav"):
        prompt = str(prompt).strip()
        lyrics = str(lyrics)
        if not prompt or len(prompt) > 2000 or len(lyrics) > 20000:
            raise ValueError("Prompt or lyrics length is outside the allowed range.")
        if not isinstance(duration, (int, float)) or not 10 <= duration <= 600:
            raise ValueError("Duration must be between 10 and 600 seconds.")
        if bpm is not None and (not isinstance(bpm, int) or not 30 <= bpm <= 300):
            raise ValueError("BPM must be an integer from 30 to 300.")
        if not isinstance(thinking, bool):
            raise ValueError("thinking must be a boolean.")
        if audio_format not in ("wav", "flac", "mp3", "opus"):
            raise ValueError("Unsupported audio format.")
        if not re.fullmatch(r"[a-z]{2,8}(?:-[A-Z]{2})?", str(language)):
            raise ValueError("Invalid language code.")
        payload = {
            "prompt": prompt,
            "lyrics": lyrics,
            "vocal_language": language,
            "audio_duration": float(duration),
            "thinking": thinking,
            "audio_format": audio_format,
            "batch_size": 1,
            "use_random_seed": True
        }
        if bpm is not None:
            payload["bpm"] = bpm
        result = self._request("POST", "/release_task", payload)
        if not isinstance(result, dict) or not isinstance(result.get("task_id"), str):
            raise LocalModelError("Local model server did not return a task identifier.")
        return {"task_id": result["task_id"], "status": result.get("status", "queued")}

    def query_tasks(self, task_ids):
        if not isinstance(task_ids, list) or not 1 <= len(task_ids) <= 10:
            raise ValueError("Provide between 1 and 10 local task identifiers.")
        if any(not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", item) for item in task_ids):
            raise ValueError("Invalid task identifier.")
        result = self._request("POST", "/query_result", {"task_id_list": task_ids})
        if not isinstance(result, list):
            raise LocalModelError("Unexpected local task status response.")
        return result
