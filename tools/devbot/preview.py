"""Loopback-only application preview and read-only development progress."""
from http.client import HTTPConnection, HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / '.devbot'
PORT = 8787
UPSTREAM_PORT = 18765
HOP_HEADERS = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
               'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length'}


def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return {}


def progress():
    state = read_json(RUNTIME / 'state.json')
    result = {key: state.get(key) for key in
              ('cycle', 'status', 'updated_at', 'next_run_at', 'last_error', 'preview')}
    result['revision'] = read_json(RUNTIME / 'preview.json').get('revision')
    result['tests'] = [{key: test.get(key) for key in ('outcome', 'exit_code')}
                       for test in state.get('last_tests', [])]
    result['report'] = ''
    report = state.get('last_report')
    if report:
        path = Path(report).resolve()
        if path.is_relative_to((RUNTIME / 'runs').resolve()) and path.is_file():
            result['report'] = path.read_text(encoding='utf-8', errors='replace')[-24000:]
    return result


LIVE_SCRIPT = b'''<script>
(() => {
  let revision;
  setInterval(async () => {
    try {
      const response = await fetch('/__devbot/status', {cache: 'no-store'});
      if (!response.ok) return;
      const state = await response.json();
      if (!state.revision) return;
      if (revision && revision !== state.revision) {
        // Wait while the user edits a form; reload when they leave the field.
        if (document.activeElement.matches('input,textarea,select,[contenteditable]')) return;
        location.reload();
      }
      revision = state.revision;
    } catch (_) {}
  }, 3000);
})();
</script>'''

PAGE = '''<!doctype html><html lang="pl"><meta charset="utf-8">
<title>Postęp pracy bota</title><style>
body{font:16px system-ui;background:#101827;color:#e5edf8;max-width:1050px;margin:40px auto;padding:0 24px}
a{color:#7dd3fc}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#1b273b;padding:20px;border-radius:12px}
small{color:#a9b9ce}</style><h1>Postęp pracy bota</h1>
<p><a href="/" target="_blank">Otwórz aplikację ↗</a></p>
<p id="status">Łączenie…</p><small>Aktualizacja co 3 sekundy. Aplikacja odświeża się po udanym zbudowaniu nowej wersji.</small>
<h2>Ostatni raport</h2><pre id="report">Brak raportu.</pre>
<h2>Szczegóły</h2><pre id="details"></pre>
<script>
async function update() {
  try {
    const response = await fetch('/__devbot/status', {cache:'no-store'});
    if (!response.ok) throw new Error('Brak połączenia');
    const state = await response.json();
    document.getElementById('status').textContent = 'Cykl ' + (state.cycle || 0) + ' · ' + (state.status || 'nie uruchomiono');
    document.getElementById('report').textContent = state.report || 'Brak raportu.';
    delete state.report;
    document.getElementById('details').textContent = JSON.stringify(state, null, 2);
  } catch (_) { document.getElementById('status').textContent = 'Utracono połączenie z podglądem. Ponawiam…'; }
}
update(); setInterval(update, 3000);
</script></html>'''.encode('utf-8')


class Handler(BaseHTTPRequestHandler):
    def respond(self, code, body, content_type):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/__devbot/status':
            self.respond(200, json.dumps(progress(), ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
        elif path in ('/__devbot', '/__devbot/'):
            self.respond(200, PAGE, 'text/html; charset=utf-8')
        else:
            self.proxy()

    def proxy(self):
        # No user-selected upstream and no filesystem serving.
        if not self.path.startswith('/') or self.path.startswith('//'):
            self.respond(400, b'Invalid path', 'text/plain')
            return
        connection = HTTPConnection('127.0.0.1', UPSTREAM_PORT, timeout=65)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 0 or length > 256 * 1024 * 1024 or self.headers.get('Transfer-Encoding'):
                self.respond(413, b'Unsupported request size', 'text/plain')
                return
            body = self.rfile.read(length) if length else None
            headers = {key: value for key, value in self.headers.items()
                       if key.lower() not in HOP_HEADERS | {'accept-encoding', 'if-none-match', 'if-modified-since'}}
            headers['Accept-Encoding'] = 'identity'
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read()
            if 'text/html' in response.getheader('Content-Type', ''):
                data = data.replace(b'</body>', LIVE_SCRIPT + b'</body>')
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in HOP_HEADERS | {'cache-control', 'etag', 'last-modified'}:
                    self.send_header(key, value)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(data)
        except (OSError, ValueError, HTTPException):
            self.respond(502, b'Application restarting. Please retry shortly.', 'text/plain')
        finally:
            connection.close()

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = proxy
    do_HEAD = do_GET


def serve():
    RUNTIME.mkdir(exist_ok=True)
    stop_file = RUNTIME / 'PREVIEW_STOP'
    stop_file.unlink(missing_ok=True)
    with ThreadingHTTPServer(('127.0.0.1', PORT), Handler) as server:
        server.timeout = 1
        while not stop_file.exists():
            server.handle_request()


if __name__ == '__main__':
    serve()
