"""
Private local server + Eikon helper.

  * Serves the private dashboard at  http://localhost:8765/External-Manager/
  * Runs a small Eikon helper API on the same port. The PUBLIC site
    (cadenypatel.github.io/External-Manager) can call it from YOUR browser to
    load holdings/trades straight from Eikon on this PC.

Privacy:
  * Bound to 127.0.0.1, so other computers cannot reach it.
  * The helper only answers pages from the origins in ALLOWED_ORIGINS, so other
    websites cannot read your Eikon data through it.
  * Your app key is only used here to talk to Eikon. It is never stored by this
    server and never sent anywhere else. Eikon data goes from Eikon to your
    browser and nowhere else.

Close the window (or Ctrl+C) to stop.
"""

import http.server
import json
import socketserver
import sys
import threading
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

SITE = HERE.parent / "site"
PREFIX = "/External-Manager"
PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8765)
URL = f"http://localhost:{PORT}{PREFIX}/"
ALLOWED_ORIGINS = {
    "https://cadenypatel.github.io",          # the public site
    f"http://localhost:{PORT}",               # the private dashboard
    f"http://127.0.0.1:{PORT}",
}
_job_lock = threading.Lock()
_job = {"state": "idle", "progress": "", "result": None, "error": None}   # one Eikon pull at a time


def _run_pull(app_key):
    def progress(msg):
        _job["progress"] = msg
    try:
        import lseg_source
        from manager_vol_tracker import FUNDS, _clean
        res = lseg_source.pull(FUNDS, start=None, app_key=app_key, progress=progress)
        _job["result"] = _clean({"status": res["status"], "holdings": res["holdings"], "errors": res.get("errors", [])[:20]})
        _job["state"] = "done"
    except Exception as e:
        _job["error"] = f"Eikon pull failed: {e}"
        _job["state"] = "error"
    finally:
        app_key = None                                 # key is only held for the duration of the pull


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    # ---------- helpers ----------
    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return origin is None or origin in ALLOWED_ORIGINS   # no Origin = same-origin / direct

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")   # lets a public https page call localhost

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, to):
        self.send_response(301)
        self.send_header("Location", to)
        self.end_headers()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass

    # ---------- API ----------
    def do_OPTIONS(self):
        if self.path.startswith("/api/") and self.headers.get("Origin") in ALLOWED_ORIGINS:
            self.send_response(204)
            self._cors()
            self.end_headers()
        else:
            self.send_error(403)

    def do_POST(self):
        if self.path.split("?")[0] != "/api/eikon/holdings":
            return self.send_error(404)
        if not self._origin_ok():
            return self._json(403, {"error": "origin not allowed"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}") if n else {}
        except Exception:
            return self._json(400, {"error": "bad request"})
        app_key = (req.get("app_key") or "").strip() or None
        with _job_lock:
            if _job["state"] == "running":
                return self._json(202, {"state": "running", "progress": _job["progress"]})   # join the running pull
            _job.update(state="running", progress="Connecting to Eikon…", result=None, error=None)
            threading.Thread(target=_run_pull, args=(app_key,), daemon=True).start()
        return self._json(202, {"state": "running", "progress": _job["progress"]})

    # ---------- static dashboard ----------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/eikon/ping":
            if not self._origin_ok():
                return self._json(403, {"error": "origin not allowed"})
            return self._json(200, {"ok": True, "helper": "equity-manager-tracker", "version": 2})
        if path == "/api/eikon/status":
            if not self._origin_ok():
                return self._json(403, {"error": "origin not allowed"})
            out = {"state": _job["state"], "progress": _job["progress"]}
            if _job["state"] == "done":
                out["result"] = _job["result"]
            elif _job["state"] == "error":
                out["error"] = _job["error"]
            return self._json(200, out)
        if path in ("/", PREFIX):
            return self._redirect(PREFIX + "/")
        if not path.startswith(PREFIX + "/"):
            return self.send_error(404, "Not found - the dashboard is at " + PREFIX + "/")
        self.path = self.path[len(PREFIX):]
        return super().do_GET()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = False


if __name__ == "__main__":
    try:
        httpd = Server(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"Port {PORT} is busy - the dashboard/helper is probably already running.")
        if "--no-browser" not in sys.argv:
            webbrowser.open(URL)
        sys.exit(0)
    print(f"Private dashboard: {URL}")
    print("Eikon helper: ready for the public site's 'Enter Eikon API key' box.")
    print("(Private to this PC. Close this window to stop.)")
    if "--no-browser" not in sys.argv:
        webbrowser.open(URL)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
