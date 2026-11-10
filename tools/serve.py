import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
HEADERS = []
for line in (ROOT / '_headers').read_text().splitlines():
    if line.startswith(' ') and ':' in line:
        name, value = line.strip().split(':', 1)
        HEADERS.append((name.strip(), value.strip()))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript', '.woff2': 'font/woff2'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        for name, value in HEADERS:
            self.send_header(name, value)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
