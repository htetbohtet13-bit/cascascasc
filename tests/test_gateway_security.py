"""Gateway regressions; outbound provider transport is always mocked."""
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request

spec = importlib.util.spec_from_file_location("gateway_proxy", Path(__file__).resolve().parents[1] / "gateway" / "proxy.py")
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class QuietHandler(gateway.GatewayHandler):
    def log_message(self, *_args):
        pass

    def log_error(self, *_args):
        pass


class GatewaySecurityTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"GATEWAY_SECRET": "local-test-secret", "PROVIDER_API_HOST": "provider.example"})
        self.environment.start()
        self.server = gateway.BoundedHTTPServer(("127.0.0.1", 0), QuietHandler, max_workers=2)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.environment.stop()

    def relay(self, target="https://provider.example/api/v1/games", secret="local-test-secret", **overrides):
        envelope = {"targetUrl": target, "method": "GET", "rawBody": "", "headers": {"X-Operator-Code": "local-operator", "X-Timestamp": "1", "X-Signature": "local-test-signature"}, **overrides}
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        try:
            # Authentication fails before a body is read; do not race an early
            # response with a later client body write on Windows TCP sockets.
            body = json.dumps(envelope) if secret == "local-test-secret" else None
            connection.request("POST", "/proxy", body=body, headers={"Content-Type": "application/json", "X-Gateway-Secret": secret})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_auth_and_disallowed_targets_never_contact_upstream(self):
        with patch.object(gateway.UPSTREAM_OPENER, "open", side_effect=AssertionError("No upstream allowed")):
            self.assertEqual(self.relay(secret="wrong")[0], 401)
            for target in ["http://provider.example/api/v1/games", "https://127.0.0.1/api/v1/games", "https://provider.example:8443/api/v1/games", "https://user@provider.example/api/v1/games", "https://provider.example/api/v1/games?x=1", "https://provider.example/api/v1/other", "https://provider.example:notaport/api/v1/games"]:
                self.assertIn(self.relay(target=target)[0], (400, 403))
            self.assertEqual(self.relay(method=[])[0], 400)

    def test_oversized_envelope_is_rejected_before_reading_or_forwarding(self):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        with patch.object(gateway.UPSTREAM_OPENER, "open", side_effect=AssertionError("No upstream allowed")):
            try:
                connection.request("POST", "/proxy", body=None, headers={"Content-Type": "application/json", "X-Gateway-Secret": "local-test-secret", "Content-Length": str(gateway.MAX_BODY_BYTES + 1)})
                response = connection.getresponse()
                self.assertEqual(response.status, 413)
                response.read()
            finally:
                connection.close()

    def test_redirects_are_disabled_for_every_supported_redirect_status(self):
        for status in [301, 302, 303, 307, 308]:
            request = Request("https://provider.example/api/v1/games", headers={"X-Signature": "local-test"})
            with self.assertRaises(HTTPError):
                gateway.NoRedirects().redirect_request(request, None, status, "Redirect", {}, "http://127.0.0.1/internal")
        redirected = HTTPError("https://provider.example/api/v1/games", 302, "Redirect", {}, io.BytesIO())
        with patch.object(gateway.UPSTREAM_OPENER, "open", side_effect=redirected):
            status, body = self.relay()
            self.assertEqual(status, 502)
            self.assertIn("redirects", body["error"])

    def test_success_preserves_signed_request_bytes(self):
        class Upstream:
            status = 200
            headers = {"Content-Type": "application/json"}
            def __enter__(self): return self
            def __exit__(self, *_args): pass
            def read(self, _size): return b'{"games":[]}'
        body = '{ "player_id": "local-player", "token": "local-token" }'
        with patch.object(gateway.UPSTREAM_OPENER, "open", return_value=Upstream()) as opened:
            self.assertEqual(self.relay(target="https://provider.example/api/v1/game/launch", method="POST", rawBody=body)[0], 200)
            self.assertEqual(opened.call_args.args[0].data, body.encode())
            self.assertEqual(opened.call_args.kwargs["timeout"], 10)

    def test_incomplete_headers_have_absolute_deadline(self):
        with patch.object(gateway, "REQUEST_TIMEOUT_SECONDS", 0.15):
            connection = socket.create_connection(self.server.server_address, timeout=2)
            try:
                connection.sendall(b"POST /proxy HTTP/1.1\r\nHost: local\r\n")
                self.assertEqual(connection.recv(1), b"")
            finally:
                connection.close()

    def test_incomplete_authenticated_body_has_absolute_deadline(self):
        with patch.object(gateway, "REQUEST_TIMEOUT_SECONDS", 0.15):
            connection = socket.create_connection(self.server.server_address, timeout=2)
            try:
                connection.sendall(b"POST /proxy HTTP/1.1\r\nHost: local\r\nX-Gateway-Secret: local-test-secret\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{")
                self.assertEqual(connection.recv(1), b"")
            finally:
                connection.close()

    def test_worker_limit_refuses_extra_connection(self):
        self.server.workers.acquire()
        self.server.workers.acquire()
        try:
            connection = socket.create_connection(self.server.server_address, timeout=2)
            try:
                self.assertEqual(connection.recv(1), b"")
            finally:
                connection.close()
        finally:
            self.server.workers.release()
            self.server.workers.release()


if __name__ == "__main__":
    unittest.main()
