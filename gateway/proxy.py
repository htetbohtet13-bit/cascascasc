#!/usr/bin/env python3
"""Small, restricted relay for the Shan Koe Mee operator API."""

import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

MAX_BODY_BYTES = 128 * 1024
UPSTREAM_TIMEOUT_SECONDS = 10
ALLOWED_ROUTES = {
    ("GET", "/api/v1/games"),
    ("POST", "/api/v1/game/launch"),
}
FORWARDED_HEADERS = {
    "x-operator-code": "X-Operator-Code",
    "x-timestamp": "X-Timestamp",
    "x-signature": "X-Signature",
    "content-type": "Content-Type",
}


def json_bytes(value):
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


class GatewayHandler(BaseHTTPRequestHandler):
    server_version = "J777Gateway"

    def send_json(self, status, value):
        body = json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.send_json(200, {"ok": True})
        return self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/proxy":
            return self.send_json(404, {"error": "Not found"})

        expected_secret = os.environ.get("GATEWAY_SECRET", "")
        supplied_secret = self.headers.get("X-Gateway-Secret", "")
        if not expected_secret or not hmac.compare_digest(supplied_secret, expected_secret):
            return self.send_json(401, {"error": "Unauthorized"})

        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_json(400, {"error": "Invalid content length"})
        if size < 1 or size > MAX_BODY_BYTES:
            return self.send_json(413, {"error": "Request body size is not allowed"})

        try:
            envelope = json.loads(self.rfile.read(size))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.send_json(400, {"error": "Invalid JSON request"})
        if not isinstance(envelope, dict):
            return self.send_json(400, {"error": "Invalid proxy request"})

        method = envelope.get("method")
        raw_url = envelope.get("targetUrl")
        raw_body = envelope.get("rawBody", "")
        headers = envelope.get("headers")
        if not isinstance(raw_url, str) or not isinstance(raw_body, str) or not isinstance(headers, dict):
            return self.send_json(400, {"error": "Missing proxy request fields"})

        target = urlsplit(raw_url)
        allowed_host = os.environ.get("PROVIDER_API_HOST", "skm.african-buffalo.net").strip().lower()
        if (
            target.scheme != "https"
            or target.hostname is None
            or target.hostname.lower() != allowed_host
            or target.port not in (None, 443)
            or target.username is not None
            or target.password is not None
            or target.query
            or target.fragment
            or (method, target.path) not in ALLOWED_ROUTES
        ):
            return self.send_json(403, {"error": "Target is not allowed"})

        if method == "GET" and raw_body:
            return self.send_json(400, {"error": "GET request body is not allowed"})
        body = raw_body.encode("utf-8")
        if len(body) > MAX_BODY_BYTES:
            return self.send_json(413, {"error": "Upstream body size is not allowed"})
        if method == "POST":
            try:
                json.loads(body)
            except (json.JSONDecodeError, UnicodeDecodeError):
                return self.send_json(400, {"error": "Upstream body must be JSON"})

        forwarded = {}
        for incoming_name, outgoing_name in FORWARDED_HEADERS.items():
            value = headers.get(incoming_name) or headers.get(outgoing_name)
            if isinstance(value, str) and "\r" not in value and "\n" not in value:
                forwarded[outgoing_name] = value
        required_headers = ("X-Operator-Code", "X-Timestamp", "X-Signature")
        if any(name not in forwarded for name in required_headers):
            return self.send_json(400, {"error": "Provider signature headers are missing"})

        upstream_body = body if method == "POST" else None
        request = Request(raw_url, data=upstream_body, headers=forwarded, method=method)
        try:
            with urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
                upstream_status = response.status
                upstream_type = response.headers.get("Content-Type", "application/json")
                upstream_data = response.read(MAX_BODY_BYTES + 1)
        except HTTPError as error:
            upstream_status = error.code
            upstream_type = error.headers.get("Content-Type", "application/json")
            upstream_data = error.read(MAX_BODY_BYTES + 1)
        except (TimeoutError, URLError, OSError) as error:
            self.log_error("provider request failed: %s", type(error).__name__)
            return self.send_json(502, {"error": "Could not reach the game provider"})

        if len(upstream_data) > MAX_BODY_BYTES:
            return self.send_json(502, {"error": "Provider response is too large"})
        self.send_response(upstream_status)
        self.send_header("Content-Type", upstream_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(upstream_data)))
        self.end_headers()
        self.wfile.write(upstream_data)

    def log_error(self, format_string, *args):
        # Avoid logging credentials or request bodies.
        print("gateway error:", format_string % args, flush=True)

    def log_message(self, format_string, *args):
        print("gateway:", format_string % args, flush=True)


if __name__ == "__main__":
    secret = os.environ.get("GATEWAY_SECRET", "")
    if not secret:
        raise SystemExit("GATEWAY_SECRET is required")
    port = int(os.environ.get("PORT", "3001"))
    server = ThreadingHTTPServer(("0.0.0.0", port), GatewayHandler)
    print(f"J777 provider gateway listening on 0.0.0.0:{port}", flush=True)
    server.serve_forever()
