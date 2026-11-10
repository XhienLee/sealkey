import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RULES = []
for line in (ROOT / '_headers').read_text().splitlines():
    if line.startswith('/'):
        RULES.append((line.strip(), []))
    elif line.startswith(' ') and ':' in line and RULES:
        name, value = line.strip().split(':', 1)
        RULES[-1][1].append((name.strip(), value.strip()))


def matches(pattern, path):
    if pattern.endswith('*'):
        return path.startswith(pattern[:-1])
    return path == pattern


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        path = self.path.split('?', 1)[0].split('#', 1)[0]
        sent = set()
        for pattern, headers in RULES:
            if matches(pattern, path):
                for name, value in headers:
                    self.send_header(name, value)
                    sent.add(name.lower())
        if 'cache-control' not in sent:
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
