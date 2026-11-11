"""
Private local web server for the dashboard.

Serves the site/ folder at  http://localhost:8765/External-Manager/
Only reachable from this PC (bound to 127.0.0.1). Ctrl+C or close the window to stop.
"""

import http.server
import socketserver
import sys
import webbrowser
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"
PREFIX = "/External-Manager"
PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8765)
URL = f"http://localhost:{PORT}{PREFIX}/"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    def _redirect(self, to):
        self.send_response(301)
        self.send_header("Location", to)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", PREFIX):                      # bare root or missing slash -> dashboard
            return self._redirect(PREFIX + "/")
        if not path.startswith(PREFIX + "/"):
            return self.send_error(404, "Not found - the dashboard is at " + PREFIX + "/")
        self.path = self.path[len(PREFIX):]           # strip the prefix, serve from site/
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always show the latest refresh
        super().end_headers()

    def log_message(self, *a):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    try:
        httpd = Server(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"Port {PORT} is busy - the dashboard is probably already running. Opening it.")
        webbrowser.open(URL)
        sys.exit(0)
    print(f"Dashboard: {URL}\n(Private to this PC. Close this window to stop.)")
    if "--no-browser" not in sys.argv:
        webbrowser.open(URL)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
