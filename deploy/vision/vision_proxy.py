#!/usr/bin/env python3
"""Stateless, authenticated OpenAI-compatible proxy for CanvDoAI vision analysis."""

from __future__ import annotations

import hmac
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer


LISTEN_HOST = os.environ.get("CANVDOAI_VISION_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("CANVDOAI_VISION_PORT", "8000"))
API_KEY = os.environ.get("CANVDOAI_VISION_API_KEY", "")
UPSTREAM = os.environ.get("CANVDOAI_VISION_UPSTREAM", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("CANVDOAI_VISION_MODEL", "qwen3-vl:4b")
MAX_BODY = int(os.environ.get("CANVDOAI_VISION_MAX_BODY", str(64 * 1024 * 1024)))


class Handler(BaseHTTPRequestHandler):
    server_version = "CanvDoAIVision/1.0"

    def log_message(self, _format: str, *_args: object) -> None:
        # Do not retain request paths, source addresses, prompts, images or results.
        return

    def _send(self, status: int, payload: dict[str, object]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        supplied = self.headers.get("authorization", "")
        expected = f"Bearer {API_KEY}"
        return bool(API_KEY) and hmac.compare_digest(supplied, expected)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            try:
                with urllib.request.urlopen(f"{UPSTREAM}/api/version", timeout=5) as response:
                    ready = response.status == 200
            except Exception:
                ready = False
            self._send(200 if ready else 503, {"ready": ready})
            return
        if self.path == "/v1/models":
            if not self._authorized():
                self._send(401, {"error": {"message": "Unauthorized"}})
                return
            self._send(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "canvdoai-local"}]})
            return
        self._send(404, {"error": {"message": "Not found"}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/chat/completions":
            self._send(404, {"error": {"message": "Not found"}})
            return
        if not self._authorized():
            self._send(401, {"error": {"message": "Unauthorized"}})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_BODY:
            self._send(413, {"error": {"message": "Request body is missing or too large"}})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict) or not isinstance(payload.get("messages"), list):
                raise ValueError("invalid messages")
            payload["model"] = MODEL
            payload["stream"] = False
            completion_limit = payload.pop("max_completion_tokens", None)
            if completion_limit is not None and "max_tokens" not in payload:
                payload["max_tokens"] = completion_limit
            request = urllib.request.Request(
                f"{UPSTREAM}/v1/chat/completions",
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={"content-type": "application/json", "authorization": "Bearer ollama"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=600) as response:
                data = response.read()
                status = response.status
                content_type = response.headers.get("content-type", "application/json")
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except urllib.error.HTTPError as error:
            # Forward the model error only; request content is never persisted or logged.
            data = error.read()
            self.send_response(error.code)
            self.send_header("content-type", "application/json")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            self._send(502, {"error": {"message": "Vision analysis service failed"}})


if __name__ == "__main__":
    if not API_KEY:
        raise SystemExit("CANVDOAI_VISION_API_KEY is required")
    HTTPServer((LISTEN_HOST, LISTEN_PORT), Handler).serve_forever()
