"""The DevTools protocol client behind `cswap project-move auto` (cdp.py).

The WebSocket framing is checked against hand-built frames over a socket
pair; finding the browser is checked against fake install places. Driving a
real browser is covered by tests/test_project_move_auto.py.
"""

from __future__ import annotations

import http.server
import json
import os
import socket
import socketserver
import struct
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from claude_swap import cdp


def _pair() -> tuple[cdp.WebSocket, socket.socket]:
    """A client WebSocket wired to the far end of a socket pair (no handshake)."""
    near, far = socket.socketpair()
    ws = cdp.WebSocket.__new__(cdp.WebSocket)
    ws._sock = near
    ws._buf = b""
    return ws, far


def _server_frame(opcode: int, payload: bytes, fin: bool = True) -> bytes:
    """An unmasked frame, as a server sends it."""
    n = len(payload)
    first = (0x80 if fin else 0) | opcode
    if n < 126:
        return struct.pack("!BB", first, n) + payload
    if n < 1 << 16:
        return struct.pack("!BBH", first, 126, n) + payload
    return struct.pack("!BBQ", first, 127, n) + payload


def _read_client_frame(sock: socket.socket) -> tuple[int, bytes]:
    """Read and unmask one frame a client sent."""

    def exact(n: int) -> bytes:
        out = b""
        while len(out) < n:
            out += sock.recv(n - len(out))
        return out

    b0, b1 = exact(2)
    assert b0 & 0x80, "client frames are sent whole"
    assert b1 & 0x80, "client frames must be masked"
    n = b1 & 0x7F
    if n == 126:
        (n,) = struct.unpack("!H", exact(2))
    elif n == 127:
        (n,) = struct.unpack("!Q", exact(8))
    mask = exact(4)
    data = exact(n)
    return b0 & 0x0F, bytes(b ^ mask[i % 4] for i, b in enumerate(data))


class TestFrames:
    @pytest.mark.parametrize("size", [0, 1, 125, 126, 127, 65535, 65536, 300_000])
    def test_send_masks_and_sizes_every_length(self, size):
        ws, far = _pair()
        text = ("x" * size)
        result = {}
        reader = threading.Thread(target=lambda: result.update(frame=_read_client_frame(far)))
        reader.start()
        ws.send_text(text)
        reader.join(10)
        assert result["frame"] == (0x1, text.encode())

    @pytest.mark.parametrize("size", [0, 5, 126, 70_000])
    def test_receive_every_length(self, size):
        ws, far = _pair()
        body = json.dumps({"id": 1, "result": {"v": "y" * size}})
        # From a thread: a socket pair on macOS holds only a few KB, so
        # sending a large frame before anyone reads would block for good.
        sender = threading.Thread(target=far.sendall, args=(_server_frame(0x1, body.encode()),))
        sender.start()
        assert json.loads(ws.recv_text()) == {"id": 1, "result": {"v": "y" * size}}
        sender.join(10)

    def test_a_message_in_pieces_is_put_together(self):
        ws, far = _pair()
        far.sendall(_server_frame(0x1, b'{"a":', fin=False) + _server_frame(0x0, b'"b"}'))
        assert ws.recv_text() == '{"a":"b"}'

    def test_ping_is_answered_and_skipped(self):
        ws, far = _pair()
        far.sendall(_server_frame(0x9, b"hi") + _server_frame(0x1, b"after"))
        assert ws.recv_text() == "after"
        assert _read_client_frame(far) == (0xA, b"hi")

    def test_close_frame_means_the_page_is_gone(self):
        ws, far = _pair()
        far.sendall(_server_frame(0x8, b""))
        with pytest.raises(cdp.PageClosed):
            ws.recv_text()

    def test_a_dropped_connection_means_the_page_is_gone(self):
        ws, far = _pair()
        far.close()
        with pytest.raises(cdp.PageClosed):
            ws.recv_text()

    def test_utf8_survives(self):
        ws, far = _pair()
        far.sendall(_server_frame(0x1, "caf\u00e9 \u2013 \U0001f600".encode()))
        assert ws.recv_text() == "caf\u00e9 \u2013 \U0001f600"


class _FakeSocketPage(cdp.Page):
    """A Page over a socket pair, with the far end scripted by the test."""

    def __init__(self):
        self._ws, self.far = _pair()
        self._next = 0
        self.handlers = {}
        self.target_id = ""


class TestPage:
    def _answer(self, page, *messages):
        def serve():
            _read_client_frame(page.far)
            for m in messages:
                page.far.sendall(_server_frame(0x1, json.dumps(m).encode()))

        t = threading.Thread(target=serve)
        t.start()
        return t

    def test_call_hands_events_to_handlers_while_waiting(self):
        page = _FakeSocketPage()
        seen = []
        page.handlers["Runtime.bindingCalled"] = seen.append
        t = self._answer(
            page,
            {"method": "Runtime.bindingCalled", "params": {"name": "cswapPut", "payload": "1"}},
            {"method": "Network.ignored", "params": {}},
            {"id": 1, "result": {"ok": True}},
        )
        assert page.call("Some.method") == {"ok": True}
        t.join(5)
        assert seen == [{"name": "cswapPut", "payload": "1"}]

    def test_evaluate_returns_the_value(self):
        page = _FakeSocketPage()
        t = self._answer(page, {"id": 1, "result": {"result": {"type": "number", "value": 42}}})
        assert page.evaluate("6 * 7") == 42
        t.join(5)

    def test_evaluate_raises_what_the_page_threw(self):
        page = _FakeSocketPage()
        t = self._answer(
            page,
            {
                "id": 1,
                "result": {
                    "result": {"type": "object"},
                    "exceptionDetails": {"text": "Uncaught", "exception": {"description": "Error: boom\n    at x"}},
                },
            },
        )
        with pytest.raises(cdp.EvaluationError, match="Error: boom"):
            page.evaluate("throw new Error('boom')")
        t.join(5)

    def test_protocol_errors_are_raised(self):
        page = _FakeSocketPage()
        t = self._answer(page, {"id": 1, "error": {"code": -32000, "message": "No such thing"}})
        with pytest.raises(cdp.BrowserError, match="No such thing"):
            page.call("Bad.method")
        t.join(5)

    def test_a_detached_tab_is_reported_as_closed(self):
        page = _FakeSocketPage()
        t = self._answer(page, {"method": "Inspector.detached", "params": {"reason": "target_closed"}})
        with pytest.raises(cdp.PageClosed):
            page.call("Runtime.evaluate")
        t.join(5)


class TestFindBrowser:
    def test_explicit_path_wins(self, tmp_path):
        exe = tmp_path / "my-chrome"
        exe.write_text("")
        assert cdp.find_browser(str(exe), environ={}) == str(exe)

    def test_environment_variable_next(self, tmp_path):
        exe = tmp_path / "env-chrome"
        exe.write_text("")
        assert cdp.find_browser(None, environ={cdp.BROWSER_ENV: str(exe)}) == str(exe)

    def test_a_named_browser_that_is_not_there_is_an_error(self, tmp_path):
        with pytest.raises(cdp.BrowserError, match="No browser at"):
            cdp.find_browser(str(tmp_path / "nope"), environ={})

    def test_linux_looks_on_the_path(self, tmp_path):
        exe = tmp_path / "chromium"
        exe.write_text("")
        with patch.object(cdp.shutil, "which", side_effect=lambda n: str(exe) if n == "chromium" else None):
            assert cdp.find_browser(platform="linux", environ={}) == str(exe)

    def test_none_found_names_the_fix(self):
        with patch.object(cdp.shutil, "which", return_value=None):
            with pytest.raises(cdp.BrowserError, match="--browser"):
                cdp.find_browser(platform="linux", environ={})

    def test_windows_tries_chrome_before_edge(self):
        env = {"PROGRAMFILES": r"C:\PF", "PROGRAMFILES(X86)": r"C:\PF86", "LOCALAPPDATA": r"C:\LA"}
        names = [str(p) for p in cdp._windows_candidates(env)]
        chrome = [i for i, n in enumerate(names) if n.endswith("chrome.exe") and "Google" in n]
        edge = [i for i, n in enumerate(names) if n.endswith("msedge.exe")]
        assert chrome and edge and max(chrome) < min(edge)
        assert any("LA" in n and "Google" in n for n in names)  # a per-user Chrome install


class TestBrowser:
    def test_no_port_file_means_not_running(self, tmp_path):
        assert cdp.Browser._reachable(tmp_path) is None

    def test_a_stale_port_file_means_not_running(self, tmp_path):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        (tmp_path / cdp.PORT_FILE).write_text(f"{port}\n/devtools/browser/x\n")
        assert cdp.Browser._reachable(tmp_path) is None

    def test_garbage_port_file_means_not_running(self, tmp_path):
        (tmp_path / cdp.PORT_FILE).write_text("not a port")
        assert cdp.Browser._reachable(tmp_path) is None

    def test_start_reports_a_browser_that_will_not_run(self, tmp_path):
        with pytest.raises(cdp.BrowserError, match="could not start"):
            cdp.Browser.start(str(tmp_path / "missing-exe"), tmp_path / "profile")

    @pytest.mark.skipif(os.name == "nt", reason="uses a shell script as the browser")
    def test_start_says_what_it_saw_of_a_browser_that_never_answers(self, tmp_path):
        exe = tmp_path / "fake-browser"
        exe.write_text("#!/bin/sh\nsleep 30\n")
        exe.chmod(0o755)
        profile = tmp_path / "profile"
        profile.mkdir()
        (profile / "chrome_debug.log").write_text("first\nlast words\n")
        started = []
        real_popen = cdp.subprocess.Popen

        def popen(*args, **kwargs):
            started.append(real_popen(*args, **kwargs))
            return started[-1]

        try:
            with patch.object(cdp.subprocess, "Popen", popen):
                with pytest.raises(cdp.BrowserError, match="in time") as raised:
                    cdp.Browser.start(str(exe), profile, timeout=1)
        finally:
            for process in started:
                process.kill()
                process.wait(10)
        message = str(raised.value)
        assert "still running" in message
        assert f"no {cdp.PORT_FILE}" in message
        assert "its log ends: first | last words" in message

    def test_a_first_start_gets_a_long_wait_for_its_port(self):
        # Chrome's first start on a cold CI runner took over 30 s to write
        # DevToolsActivePort at all; the default wait covers that.
        import inspect

        default = inspect.signature(cdp.Browser.start).parameters["timeout"].default
        assert default == cdp.START_TIMEOUT >= 90

    @pytest.mark.skipif(os.name == "nt", reason="uses a shell script as the browser")
    def test_a_slow_port_is_waited_for_once_the_browser_has_chosen_it(self, tmp_path):
        # The port file appears after 3 s and the port answers after 5 s:
        # past a 4 s wait from the start, within 4 s from the port file.
        # Each edge has a second or more to spare, for a busy runner.
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        exe = tmp_path / "fake-browser"
        exe.write_text(
            '#!/bin/sh\ndir="${1#--user-data-dir=}"\nsleep 3\n'
            f'printf "{port}\\n/devtools/browser/x\\n" > "$dir/{cdp.PORT_FILE}"\nsleep 30\n'
        )
        exe.chmod(0o755)

        class Version(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"Browser": "fake"}')

            def log_message(self, *args):
                pass

        class Server(http.server.HTTPServer):
            # HTTPServer looks up the host's name before it listens, which
            # on a macOS runner takes seconds this test has not got; the
            # name is never used.
            def server_bind(self):
                socketserver.TCPServer.server_bind(self)

        servers = []

        def serve_later():
            time.sleep(5)
            servers.append(Server(("127.0.0.1", port), Version))
            servers[0].serve_forever()

        threading.Thread(target=serve_later, daemon=True).start()
        started = []
        real_popen = cdp.subprocess.Popen

        def popen(*args, **kwargs):
            started.append(real_popen(*args, **kwargs))
            return started[-1]

        try:
            with patch.object(cdp.subprocess, "Popen", popen):
                browser = cdp.Browser.start(str(exe), tmp_path / "profile", timeout=4)
            assert browser.port == port
        finally:
            for process in started:
                process.kill()
                process.wait(10)
            if servers:
                servers[0].shutdown()

    def _devtools(self, tabs: list[dict]) -> tuple[http.server.HTTPServer, list[str]]:
        """A stand-in for the DevTools port: it lists ``tabs``, closes any, opens one, and logs what was asked."""
        asked: list[str] = []

        class DevTools(http.server.BaseHTTPRequestHandler):
            def _answer(self, status: int, body: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                asked.append(self.path)
                if self.path == "/json/list":
                    self._answer(200, json.dumps(tabs).encode())
                elif self.path.startswith("/json/close/"):
                    self._answer(200, b"Target is closing")  # in words, as Chrome does
                else:
                    self._answer(404, b"")

            def do_PUT(self):
                asked.append(self.path)
                self._answer(200, json.dumps({"id": "N", "type": "page", "url": "about:blank"}).encode())

            def log_message(self, *args):
                pass

        class Server(http.server.HTTPServer):
            def server_bind(self):
                socketserver.TCPServer.server_bind(self)  # no name lookup, as above

        server = Server(("127.0.0.1", 0), DevTools)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server, asked

    def test_own_tab_keeps_one_blank_tab_and_closes_the_rest(self, tmp_path):
        # Chrome 154 brings the tabs the profile's last window had back on
        # the next start, unloaded: a browser cswap starts works in a blank
        # tab of its own and closes those.
        server, asked = self._devtools([
            {"id": "R", "type": "page", "url": "http://127.0.0.1:8/"},
            {"id": "A", "type": "page", "url": "about:blank"},
            {"id": "A2", "type": "page", "url": "about:blank"},
            {"id": "W", "type": "service_worker", "url": "chrome-extension://x/w.js"},
        ])
        try:
            tab = cdp.Browser(tmp_path, server.server_address[1]).own_tab()
        finally:
            server.shutdown()
        assert tab["id"] == "A"
        assert asked == ["/json/list", "/json/close/R", "/json/close/A2"]

    def test_own_tab_opens_a_blank_tab_when_there_is_none(self, tmp_path):
        server, asked = self._devtools([{"id": "R", "type": "page", "url": "http://127.0.0.1:8/"}])
        try:
            tab = cdp.Browser(tmp_path, server.server_address[1]).own_tab()
        finally:
            server.shutdown()
        assert tab["id"] == "N"
        assert asked == ["/json/list", "/json/new?about:blank", "/json/close/R"]

    def test_close_closes_the_tabs_first_so_the_next_start_brings_none_back(self, tmp_path):
        server, asked = self._devtools([
            {"id": "A", "type": "page", "url": "about:blank"},
            {"id": "B", "type": "page", "url": "http://127.0.0.1:8/"},
            {"id": "W", "type": "service_worker", "url": "chrome-extension://x/w.js"},
        ])

        class Exited:
            returncode = 0

            def poll(self):
                return 0

            def wait(self, timeout=None):
                return 0

        try:
            cdp.Browser(tmp_path, server.server_address[1], Exited()).close()
        finally:
            server.shutdown()
        assert asked[:3] == ["/json/list", "/json/close/A", "/json/close/B"]
        assert "/json/close/W" not in asked

    @pytest.mark.skipif(os.name == "nt", reason="uses a shell script as the browser")
    def test_start_reports_a_browser_that_exits_at_once(self, tmp_path):
        exe = tmp_path / "fake-browser"
        exe.write_text("#!/bin/sh\nexit 0\n")
        exe.chmod(0o755)
        with pytest.raises(cdp.BrowserError, match="exited before"):
            cdp.Browser.start(str(exe), tmp_path / "profile", timeout=5)
