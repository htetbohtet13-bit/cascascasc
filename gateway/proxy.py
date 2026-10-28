#!/usr/bin/env python3
"""Small, restricted relay for the Shan Koe Mee operator API."""

import hmac
import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_BODY_BYTES = 128 * 1024
UPSTREAM_TIMEOUT_SECONDS = 10
REQUEST_TIMEOUT_SECONDS = 15
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


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise HTTPError(request.full_url, code, "Provider redirects are not allowed", headers, response)


UPSTREAM_OPENER = build_opener(NoRedirects())


class BoundedHTTPServer(ThreadingHTTPServer):
    def __init__(self, address, handler, max_workers=32):
        self.workers = threading.BoundedSemaphore(max_workers)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self.workers.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.workers.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.workers.release()


class GatewayHandler(BaseHTTPRequestHandler):
    server_version = "J777Gateway"
    timeout = 10

    def setup(self):
        super().setup()
        # A socket inactivity timeout alone does not stop a client trickling bytes.
        self.request_deadline = threading.Timer(REQUEST_TIMEOUT_SECONDS, self.expire_request)
        self.request_deadline.daemon = True
        self.request_deadline.start()

    def expire_request(self):
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def finish(self):
        self.request_deadline.cancel()
        try:
            super().finish()
        except OSError:
            pass

    def handle(self):
        try:
            super().handle()
        except OSError as error:
            self.log_error("client transport closed: %s", type(error).__name__)

    def send_json(self, status, value):
        body = json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.close_connection = True
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
        if not expected_secret or not hmac.compare_digest(supplied_secret.encode("utf-8"), expected_secret.encode("utf-8")):
            return self.send_json(401, {"error": "Unauthorized"})

        if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
            return self.send_json(400, {"error": "A single content length is required"})
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            return self.send_json(415, {"error": "JSON content type is required"})

        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_json(400, {"error": "Invalid content length"})
        if size < 1 or size > MAX_BODY_BYTES:
            return self.send_json(413, {"error": "Request body size is not allowed"})

        try:
            data = self.rfile.read(size)
            if len(data) != size:
                return self.send_json(400, {"error": "Incomplete request body"})
            envelope = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.send_json(400, {"error": "Invalid JSON request"})
        if not isinstance(envelope, dict):
            return self.send_json(400, {"error": "Invalid proxy request"})

        method = envelope.get("method")
        raw_url = envelope.get("targetUrl")
        raw_body = envelope.get("rawBody", "")
        headers = envelope.get("headers")
        if method not in ("GET", "POST") or not isinstance(raw_url, str) or not isinstance(raw_body, str) or not isinstance(headers, dict):
            return self.send_json(400, {"error": "Missing proxy request fields"})

        try:
            target = urlsplit(raw_url)
            target_port = target.port
        except ValueError:
            return self.send_json(400, {"error": "Invalid target URL"})
        allowed_host = os.environ.get("PROVIDER_API_HOST", "shan-24.chapm382.com").strip().lower()
        if (
            target.scheme != "https"
            or target.hostname is None
            or target.hostname.lower() != allowed_host
            or target_port not in (None, 443)
            or target.username is not None
            or target.password is not None
            or target.query
            or target.fragment
            or any(ord(char) <= 32 or ord(char) == 127 for char in raw_url)
            or (method, target.path) not in ALLOWED_ROUTES
        ):
            return self.send_json(403, {"error": "Target is not allowed"})

        if method == "GET" and raw_body:
            return self.send_json(400, {"error": "GET request body is not allowed"})
        try:
            body = raw_body.encode("utf-8")
        except UnicodeEncodeError:
            return self.send_json(400, {"error": "Upstream body must be valid UTF-8"})
        if len(body) > MAX_BODY_BYTES:
            return self.send_json(413, {"error": "Upstream body size is not allowed"})
        if method == "POST":
            try:
                json.loads(body)
            except (json.JSONDecodeError, UnicodeDecodeError):
                return self.send_json(400, {"error": "Upstream body must be JSON"})

        # Identify this as a server-side API client instead of urllib's generic default UA.
        forwarded = {
            "User-Agent": "J777-Operator-Gateway/1.0",
            "Accept": "application/json",
        }
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
            with UPSTREAM_OPENER.open(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
                upstream_status = response.status
                upstream_type = response.headers.get("Content-Type", "application/json")
                upstream_data = response.read(MAX_BODY_BYTES + 1)
        except HTTPError as error:
            if 300 <= error.code < 400:
                error.close()
                return self.send_json(502, {"error": "Provider redirects are not allowed"})
            upstream_status = error.code
            upstream_type = error.headers.get("Content-Type", "application/json")
            upstream_data = error.read(MAX_BODY_BYTES + 1)
        except (TimeoutError, URLError, OSError) as error:
            self.log_error("provider request failed: %s", type(error).__name__)
            return self.send_json(502, {"error": "Could not reach the game provider"})

        if len(upstream_data) > MAX_BODY_BYTES:
            return self.send_json(502, {"error": "Provider response is too large"})
        if len(upstream_type) > 200 or "\r" in upstream_type or "\n" in upstream_type:
            upstream_type = "application/json"
        self.send_response(upstream_status)
        self.send_header("Content-Type", upstream_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(upstream_data)))
        self.send_header("Connection", "close")
        self.close_connection = True
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
    host = os.environ.get("HOST", "0.0.0.0")
    max_workers = max(1, min(int(os.environ.get("MAX_WORKERS", "32")), 256))
    server = BoundedHTTPServer((host, port), GatewayHandler, max_workers=max_workers)
    print(f"J777 provider gateway listening on {host}:{port}", flush=True)
    server.serve_forever()
