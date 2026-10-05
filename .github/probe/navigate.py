"""Temporary CI probe: which of the tests' conditions stops driven Chrome loading the mock on macOS."""
import http.server, socketserver, subprocess, sys, tempfile, threading, time, urllib.request
from pathlib import Path

sys.path.insert(0, "src")
from claude_swap import cdp  # noqa: E402

ARGS = ([ "--no-sandbox", "--disable-gpu"] if sys.platform.startswith("linux") else []) + ["--no-proxy-server", "--disable-features=ChromeWhatsNewUI,LocalNetworkAccessChecks,NetworkServiceSandbox", "--enable-logging", "--v=0"]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<!doctype html><title>ok</title><p>ok"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


py = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=py.serve_forever, daemon=True).start()
py_site = f"http://127.0.0.1:{py.server_address[1]}"
node = subprocess.Popen(["node", "tests/js/mock_http_server.js"], stdout=subprocess.PIPE, text=True)
node_site = f"http://127.0.0.1:{int(node.stdout.readline().split()[1])}"
for site in (py_site, node_site):
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(urllib.request.Request(site + "/"), timeout=10) as r:
            print("urllib", site, r.status, f"{time.monotonic()-t0:.2f}s", flush=True)
    except Exception as e:
        print("urllib", site, "raised", e, flush=True)
exe = cdp.find_browser()

variants = [
    ("tests-args node", ARGS, node_site),
    ("tests-args python", ARGS, py_site),
    ("no-proxy-flag-removed node", [a for a in ARGS if a != "--no-proxy-server"], node_site),
    ("no-logging node", ARGS[:2], node_site),
    ("bare node", ARGS[:0] if not sys.platform.startswith("linux") else ["--no-sandbox"], node_site),
    ("tests-args node at-profile", ARGS, node_site),
]
for name, extra, site in variants:
    base = Path(tempfile.mkdtemp())
    profile = base / ("src@example.com" if "at-profile" in name else "p")
    print(f"== {name}", flush=True)
    try:
        b = cdp.Browser.start(exe, profile, "about:blank", headless=True, extra_args=extra, timeout=60)
    except Exception as e:
        print("   start failed:", e, flush=True)
        continue
    try:
        page = b.connect(b.tab())
        print("   location before:", page.location(), flush=True)
        t0 = time.monotonic()
        try:
            print("   navigate ->", page.call("Page.navigate", {"url": site + "/"}, timeout=15), f"{time.monotonic()-t0:.1f}s", flush=True)
        except Exception as e:
            print("   navigate raised", e, f"{time.monotonic()-t0:.1f}s", flush=True)
        time.sleep(1)
        print("   location:", page.location(), flush=True)
    except Exception as e:
        print("   failed:", repr(e), flush=True)
    finally:
        try:
            b.close()
        except Exception:
            pass
    log = profile / "chrome_debug.log"
    if log.exists():
        lines = log.read_text(errors="replace").splitlines()
        print(f"   chrome_debug.log {len(lines)} lines, last 8:", flush=True)
        for l in lines[-8:]:
            print("    ", l[:300], flush=True)

print("== plain launch of node /login with the tests' args", flush=True)
profile = Path(tempfile.mkdtemp()) / "p"
p = cdp.launch_plain(exe, profile, node_site + "/login?as=x@example.com", headless=True, extra_args=ARGS)
try:
    print("   exited", p.wait(20), flush=True)
except subprocess.TimeoutExpired:
    print("   still running after 20 s", flush=True)
    p.kill()
conn = urllib.request.urlopen(node_site + "/__mock/made", timeout=5).read()
print("   mock says", conn.decode(), flush=True)
node.kill()
