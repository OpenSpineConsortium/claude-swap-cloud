"""Drive an installed Chrome or Edge through the Chrome DevTools Protocol.

`cswap project-move auto` needs a claude.ai tab per account and a way to run
the browser scripts in it without a person pasting them. This module is that
way, using the standard library only (the PC this has to run on blocks
unsigned launchers, so nothing is installed for it):

* :func:`find_browser` finds Chrome, Edge or Chromium on Windows, macOS and
  Linux.
* :class:`Browser` starts one with a profile folder of its own and a
  DevTools port (or joins one already started on that folder), and lists,
  opens and closes its tabs. A profile folder keeps its sign-ins, so each
  account signs in once.
* :class:`Page` speaks the protocol to one tab: it sends commands, waits for
  their answers, and hands events to handlers as they arrive.
* :class:`WebSocket` is the minimal RFC 6455 client the protocol runs over.

Everything here talks to 127.0.0.1 only, and never through a proxy.
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from claude_swap.exceptions import ClaudeSwitchError


class BrowserError(ClaudeSwitchError):
    """The browser could not be found, started, reached or driven."""


class PageClosed(BrowserError):
    """The tab, or the whole browser, went away."""


class EvaluationError(BrowserError):
    """Script run in the page threw."""


# ---------------------------------------------------------------------------
# Finding a browser
# ---------------------------------------------------------------------------

BROWSER_ENV = "CSWAP_BROWSER"


def _windows_candidates(environ) -> list[Path]:
    roots = [
        environ.get("PROGRAMFILES", r"C:\Program Files"),
        environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
        environ.get("LOCALAPPDATA", ""),
    ]
    tails = [
        r"Google\Chrome\Application\chrome.exe",
        r"Microsoft\Edge\Application\msedge.exe",
        r"Chromium\Application\chrome.exe",
    ]
    # Chrome first wherever it is installed, then Edge, which every Windows has.
    return [Path(root) / tail for tail in tails for root in roots if root]


_MAC_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

_LINUX_NAMES = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "msedge",
]


def find_browser(explicit: str | None = None, platform: str | None = None, environ=None) -> str:
    """The Chrome, Edge or Chromium to drive.

    ``explicit`` (``--browser``) wins, then ``$CSWAP_BROWSER``, then the usual
    install places for the platform. Raises :class:`BrowserError` when none
    is found, naming the option that fixes it.
    """
    env = os.environ if environ is None else environ
    plat = platform or sys.platform
    for given in (explicit, env.get(BROWSER_ENV)):
        if given and given.strip():
            value = given.strip().strip('"')
            found = shutil.which(value) or (value if os.path.isfile(value) else None)
            if not found:
                raise BrowserError(f"No browser at {value!r}.")
            return found
    if plat == "win32":
        candidates = [str(p) for p in _windows_candidates(env)]
    elif plat == "darwin":
        candidates = list(_MAC_CANDIDATES)
    else:
        candidates = [found for name in _LINUX_NAMES if (found := shutil.which(name))]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    raise BrowserError(
        "Chrome or Edge was not found. Install one, or name it with --browser PATH "
        f"(or set {BROWSER_ENV})."
    )


# ---------------------------------------------------------------------------
# HTTP to the DevTools port (no proxy: it is always this computer)
# ---------------------------------------------------------------------------


def _http_json(port: int, method: str, path: str, timeout: float = 5.0):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request(method, path)
        resp = conn.getresponse()
        body = resp.read()
        if resp.status != 200:
            raise BrowserError(f"DevTools answered {resp.status} to {path}")
        return json.loads(body or b"null")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# WebSocket (RFC 6455, client side, text frames)
# ---------------------------------------------------------------------------


class WebSocket:
    """A blocking WebSocket client: enough for the DevTools protocol."""

    def __init__(self, url: str, timeout: float = 10.0):
        parts = urlsplit(url)
        if parts.scheme != "ws":
            raise BrowserError(f"not a DevTools address: {url}")
        host = parts.hostname or "127.0.0.1"
        port = parts.port or 80
        path = parts.path + (f"?{parts.query}" if parts.query else "")
        self._sock = socket.create_connection((host, port), timeout=timeout)
        self._buf = b""
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        # No Origin header: the DevTools port turns away pages, not programs.
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self._sock.sendall(request.encode("ascii"))
        head = self._read_until(b"\r\n\r\n")
        status = head.split(b"\r\n", 1)[0]
        if b" 101 " not in status + b" ":
            self.close()
            raise BrowserError(f"DevTools refused the connection: {status.decode('latin-1')}")

    def _read_until(self, marker: bytes) -> bytes:
        while marker not in self._buf:
            data = self._sock.recv(65536)
            if not data:
                raise PageClosed("the browser closed the connection")
            self._buf += data
        head, self._buf = self._buf.split(marker, 1)
        return head

    def _read_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            data = self._sock.recv(max(65536, n - len(self._buf)))
            if not data:
                raise PageClosed("the browser closed the connection")
            self._buf += data
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def settimeout(self, seconds: float | None) -> None:
        self._sock.settimeout(seconds)

    @staticmethod
    def frame(opcode: int, payload: bytes, mask: bytes | None = None) -> bytes:
        """One final, masked client frame."""
        mask = mask if mask is not None else os.urandom(4)
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 1 << 16:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        if n:
            # XOR with the mask as one big integer: fast for megabyte frames.
            full = (mask * (n // 4 + 1))[:n]
            masked = (int.from_bytes(payload, "big") ^ int.from_bytes(full, "big")).to_bytes(n, "big")
        else:
            masked = b""
        return header + mask + masked

    def send_text(self, text: str) -> None:
        self._sock.sendall(self.frame(0x1, text.encode("utf-8")))

    def recv_text(self) -> str:
        """The next whole text message; answers pings, raises on close."""
        pieces: list[bytes] = []
        while True:
            b0, b1 = self._read_exact(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                (n,) = struct.unpack("!H", self._read_exact(2))
            elif n == 127:
                (n,) = struct.unpack("!Q", self._read_exact(8))
            mask = self._read_exact(4) if b1 & 0x80 else None
            payload = self._read_exact(n)
            if mask:
                full = (mask * (n // 4 + 1))[:n]
                payload = (int.from_bytes(payload, "big") ^ int.from_bytes(full, "big")).to_bytes(n, "big")
            if opcode == 0x8:
                raise PageClosed("the browser closed the connection")
            if opcode == 0x9:
                self._sock.sendall(self.frame(0xA, payload))
                continue
            if opcode == 0xA:
                continue
            pieces.append(payload)
            if fin:
                return b"".join(pieces).decode("utf-8")

    def close(self) -> None:
        try:
            self._sock.sendall(self.frame(0x8, b""))
        except OSError:
            pass
        try:
            self._sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# One tab
# ---------------------------------------------------------------------------


class Page:
    """The DevTools protocol, spoken to one tab."""

    def __init__(self, ws_url: str, target_id: str = ""):
        self.target_id = target_id
        self._ws = WebSocket(ws_url)
        self._next = 0
        self.handlers: dict[str, Callable[[dict], None]] = {}

    def close(self) -> None:
        self._ws.close()

    def _dispatch(self, message: dict) -> None:
        method = message.get("method")
        if method == "Inspector.detached" or method == "Target.detachedFromTarget":
            raise PageClosed("the tab was closed")
        handler = self.handlers.get(method or "")
        if handler is not None:
            handler(message.get("params") or {})

    def call(self, method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
        """Send one command and wait for its answer, handling events meanwhile."""
        self._next += 1
        ident = self._next
        self._ws.settimeout(timeout)
        try:
            self._ws.send_text(json.dumps({"id": ident, "method": method, "params": params or {}}))
            deadline = time.monotonic() + timeout
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise BrowserError(f"the browser did not answer {method} in time")
                self._ws.settimeout(left)
                message = json.loads(self._ws.recv_text())
                if message.get("id") == ident:
                    if "error" in message:
                        err = message["error"]
                        raise BrowserError(f"{method}: {err.get('message', err)}")
                    return message.get("result") or {}
                if "method" in message:
                    self._dispatch(message)
        except socket.timeout:
            raise BrowserError(f"the browser did not answer {method} in time") from None
        except OSError as e:
            raise PageClosed(f"the browser connection broke ({e})") from None

    def evaluate(self, expression: str, *, await_promise: bool = True, timeout: float = 60.0):
        """Run ``expression`` in the tab and return its value as JSON data."""
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": await_promise,
                "returnByValue": True,
                "userGesture": True,
                "allowUnsafeEvalBlockedByCSP": True,
            },
            timeout=timeout,
        )
        if "exceptionDetails" in result:
            details = result["exceptionDetails"]
            exc = details.get("exception") or {}
            text = exc.get("description") or details.get("text") or "the script failed"
            raise EvaluationError(text.splitlines()[0] if text else "the script failed")
        return (result.get("result") or {}).get("value")

    def pump(self, seconds: float) -> None:
        """Handle the events that arrive in the next ``seconds``."""
        deadline = time.monotonic() + seconds
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return
            self._ws.settimeout(left)
            try:
                message = json.loads(self._ws.recv_text())
            except socket.timeout:
                return
            except OSError as e:
                raise PageClosed(f"the browser connection broke ({e})") from None
            if "method" in message:
                self._dispatch(message)

    def navigate(self, url: str) -> None:
        result = self.call("Page.navigate", {"url": url})
        if result.get("errorText"):
            raise BrowserError(f"could not open {url}: {result['errorText']}")

    def location(self) -> tuple[str, str]:
        """``(href, readyState)`` of the tab; ``("", "")`` while it is between pages."""
        try:
            value = self.evaluate("[location.href, document.readyState]", await_promise=False, timeout=10)
        except (EvaluationError, BrowserError) as e:
            if isinstance(e, PageClosed):
                raise
            return "", ""
        if isinstance(value, list) and len(value) == 2:
            return str(value[0]), str(value[1])
        return "", ""

    def wait_loaded(self, prefix: str, timeout: float = 60.0) -> str:
        """Wait until the tab shows a page under ``prefix`` and has loaded it."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            href, ready = self.location()
            if href.startswith(prefix) and ready == "complete":
                return href
            self.pump(0.25)
        raise BrowserError(f"the page under {prefix} did not finish loading")


# ---------------------------------------------------------------------------
# One browser, with a profile folder of its own
# ---------------------------------------------------------------------------

PORT_FILE = "DevToolsActivePort"


class Browser:
    """Chrome or Edge on a profile folder, reachable on a DevTools port."""

    def __init__(self, profile: Path, port: int, process: subprocess.Popen | None = None):
        self.profile = profile
        self.port = port
        self.process = process  # None when it was already running

    @property
    def launched(self) -> bool:
        return self.process is not None

    # -- starting

    @classmethod
    def _reachable(cls, profile: Path) -> int | None:
        """The port of a browser already running on ``profile``, if it answers."""
        try:
            port = int((profile / PORT_FILE).read_text(encoding="utf-8").splitlines()[0])
        except (OSError, ValueError, IndexError):
            return None
        try:
            _http_json(port, "GET", "/json/version", timeout=2)
        except (OSError, BrowserError, ValueError):
            return None
        return port

    @classmethod
    def start(
        cls,
        executable: str,
        profile: Path,
        url: str = "about:blank",
        *,
        headless: bool = False,
        extra_args: list[str] | None = None,
        timeout: float = 30.0,
    ) -> "Browser":
        """Join the browser running on ``profile``, or start one there on ``url``."""
        profile.mkdir(parents=True, exist_ok=True)
        port = cls._reachable(profile)
        if port is not None:
            return cls(profile, port)
        try:
            (profile / PORT_FILE).unlink()
        except OSError:
            pass
        args = [
            executable,
            f"--user-data-dir={profile}",
            # 0: the browser picks a free port and writes it to DevToolsActivePort.
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=ChromeWhatsNewUI",
            *(["--headless=new"] if headless else []),
            *(extra_args or []),
            url,
        ]
        kwargs: dict = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        if sys.platform == "win32":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        else:
            kwargs["start_new_session"] = True
        try:
            process = subprocess.Popen(args, **kwargs)
        except OSError as e:
            raise BrowserError(f"could not start {executable}: {e}") from None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            port = cls._reachable(profile)
            if port is not None:
                return cls(profile, port, process)
            if process.poll() is not None and not (profile / PORT_FILE).exists():
                # A browser already open on this folder without a DevTools port
                # takes the new window over, and this one exits at once.
                raise BrowserError(
                    f"The browser exited before it opened its DevTools port. If a window "
                    f"using {profile} is still open, close it and run this again."
                )
            time.sleep(0.2)
        raise BrowserError("the browser did not open its DevTools port in time")

    # -- tabs

    def tabs(self) -> list[dict]:
        """The open tabs (``type`` page), as DevTools lists them."""
        listing = _http_json(self.port, "GET", "/json/list") or []
        return [t for t in listing if isinstance(t, dict) and t.get("type") == "page"]

    def open_tab(self, url: str = "about:blank") -> dict:
        from urllib.parse import quote

        return _http_json(self.port, "PUT", "/json/new?" + quote(url, safe=":/?&=%#@"))

    def tab(self, prefer: str = "") -> dict:
        """A tab to work in: one already showing ``prefer``, else the first, else a new one."""
        tabs = self.tabs()
        for t in tabs:
            if prefer and str(t.get("url", "")).startswith(prefer):
                return t
        for t in tabs:
            if not str(t.get("url", "")).startswith(("devtools://", "chrome-extension://")):
                return t
        return self.open_tab(prefer or "about:blank")

    def connect(self, tab: dict) -> Page:
        url = tab.get("webSocketDebuggerUrl")
        if not url:
            raise BrowserError("that tab is already being driven by another DevTools client")
        return Page(url, str(tab.get("id", "")))

    def alive(self) -> bool:
        if self.process is not None and self.process.poll() is not None:
            return False
        try:
            _http_json(self.port, "GET", "/json/version", timeout=2)
            return True
        except (OSError, BrowserError, ValueError):
            return False

    def close(self, timeout: float = 10.0) -> None:
        """Close the browser (its sign-ins stay in the profile folder)."""
        try:
            version = _http_json(self.port, "GET", "/json/version", timeout=2)
            ws = WebSocket(version["webSocketDebuggerUrl"])
            try:
                ws.send_text(json.dumps({"id": 1, "method": "Browser.close"}))
                ws.settimeout(timeout)
                try:
                    ws.recv_text()
                except (OSError, BrowserError):
                    pass
            finally:
                ws.close()
        except (OSError, BrowserError, ValueError, KeyError):
            pass
        if self.process is not None:
            try:
                self.process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.process.kill()
            return
        # Started by an earlier run: wait until its port stops answering.
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and self.alive():
            time.sleep(0.2)
