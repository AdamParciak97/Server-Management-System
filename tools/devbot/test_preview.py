from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen

import preview


class Upstream(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'<html><body>Application</body></html>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(401)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class PreviewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.runtime = Path(temporary.name)
        runtime_patch = patch.object(preview, 'RUNTIME', self.runtime)
        runtime_patch.start()
        self.addCleanup(runtime_patch.stop)
        upstream = self.server(Upstream)
        port_patch = patch.object(preview, 'UPSTREAM_PORT', upstream.server_port)
        port_patch.start()
        self.addCleanup(port_patch.stop)
        self.url = 'http://127.0.0.1:' + str(self.server(preview.Handler).server_port)

    def server(self, handler):
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def test_injects_reload_and_disables_cache(self):
        with urlopen(self.url) as response:
            body = response.read()
            self.assertIn(b'Application', body)
            self.assertIn(b'/__devbot/status', body)
            self.assertEqual(int(response.headers['Content-Length']), len(body))
            self.assertEqual(response.headers['Cache-Control'], 'no-store')

    def test_preserves_api_error_status_and_body(self):
        from urllib.error import HTTPError
        with self.assertRaises(HTTPError) as caught:
            urlopen(Request(self.url + '/api/auth/login', data=b'{"test":true}',
                            headers={'Content-Type': 'application/json'}))
        self.assertEqual(caught.exception.code, 401)
        self.assertEqual(caught.exception.read(), b'{"test":true}')
        caught.exception.close()

    def test_dashboard_and_status_work_without_runtime_state(self):
        with urlopen(self.url + '/__devbot') as response:
            self.assertIn('Postęp pracy'.encode(), response.read())
        with urlopen(self.url + '/__devbot/status') as response:
            self.assertIn(b'"revision": null', response.read())


if __name__ == '__main__':
    unittest.main()
