"""Temporary CI probe: why driven Chrome cannot open http://127.0.0.1 on Windows and macOS."""
import http.server, os, shutil, socketserver, subprocess, sys, tempfile, threading, time
from pathlib import Path

sys.path.insert(0, "src")
from claude_swap import cdp  # noqa: E402


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        print("   server got", self.path, flush=True)
        body = b"<!doctype html><title>ok</title><p>ok"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
exe = cdp.find_browser()
print("browser:", exe, "port:", port, flush=True)

variants = {
    "as-tests": ["--headless=new"],
    "headful": [],
    "no-features": ["--headless=new", "--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights"],
    "headless-old": ["--headless"],
}
for name, extra in variants.items():
    profile = Path(tempfile.mkdtemp()) / "p"
    log = profile.parent / "chrome.log"
    print(f"== {name}", flush=True)
    try:
        b = cdp.Browser.start(exe, profile, "about:blank", headless=False, extra_args=[*extra, *os.environ.get("PROBE_EXTRA", "").split(), "--enable-logging", f"--log-file={log}", "--v=1"], timeout=60)
    except Exception as e:
        print("   start failed:", e, flush=True)
        continue
    try:
        tabs = b.tabs()
        print("   tabs:", [t.get("url") for t in tabs], flush=True)
        page = b.connect(b.tab())
        print("   location before:", page.location(), flush=True)
        for url in (f"http://127.0.0.1:{port}/", f"http://localhost:{port}/x", "data:text/html,<p>hi"):
            t0 = time.monotonic()
            try:
                r = page.call("Page.navigate", {"url": url}, timeout=20)
                print("   navigate", url, "->", r, f"{time.monotonic()-t0:.1f}s", flush=True)
            except Exception as e:
                print("   navigate", url, "raised", e, f"{time.monotonic()-t0:.1f}s", flush=True)
            time.sleep(2)
            print("   location:", page.location(), flush=True)
    except Exception as e:
        print("   failed:", repr(e), flush=True)
    finally:
        try:
            b.close()
        except Exception:
            pass
    try:
        lines = log.read_text(errors="replace").splitlines()
        hits = [l for l in lines if any(k in l for k in ("127.0.0.1", "ERR_", "abort", "Abort", "navigation", "Navigation", "download", "Download", "LocalNetwork", "Https"))]
        print(f"   log: {len(lines)} lines; relevant:", flush=True)
        for l in hits[:40]:
            print("    ", l[:300], flush=True)
    except OSError as e:
        print("   no log:", e, flush=True)
