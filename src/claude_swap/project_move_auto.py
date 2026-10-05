"""`cswap project-move auto`: move a claude.ai Project with no clicks.

The browser scripts behind ``cswap project-move export`` and ``import`` are
built to be pasted into a DevTools console, and each waits for a person three
times: to press its button, to choose a folder, and to answer a question or
two. This module does all of that itself, in browser windows it drives
through the Chrome DevTools Protocol (:mod:`claude_swap.cdp`):

1. One window per account, each on a profile folder of its own under the
   cswap backup directory (``browser-profiles/<email>``). A profile keeps its
   sign-in, so the person signs in to claude.ai once per account, the first
   time, and never again; every later run goes straight through.
   That first sign-in happens in a plain window, started without a
   DevTools port, because Google refuses to sign in to a browser that has
   one open: the person signs in there, closes the window, and the profile
   is then opened again with the port for everything below.
2. In the SOURCE window the project's page is opened and
   ``project-export.js`` is run with ``browser/automation.js`` in front of
   it. The folder the script writes into sends each file straight back
   here as it is written, and it is saved in the exports folder: no folder
   window, no download.
3. The export is checked exactly as ``cswap project-move check`` does.
4. In the DESTINATION window the export is loaded into the page and
   ``project-import.js`` is run on it, which creates a NEW private project.

The scripts run unchanged, so the paste-by-hand route still works as before.
"""

from __future__ import annotations

import base64
import html
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from claude_swap import project_move as pm
from claude_swap.cdp import Browser, BrowserError, EvaluationError, Page, PageClosed, find_browser, launch_plain
from claude_swap.exceptions import ValidationError

PROFILES_DIR = "browser-profiles"
SETTINGS_FILE = "project-move-auto.json"
BINDING = "cswapPut"
SIGN_IN_FILE = "cswap-sign-in.json"  # in a profile: whose sign-in the person made there
LABEL_SUFFIX = ".sign-in.html"  # beside a profile: the page its plain sign-in window opens on
CHECK_SUFFIX = ".check.html"  # beside a profile: the page its plain window opens on to pass the site's check
SESSION_COOKIE = "sessionKey"  # the cookie claude.ai keeps a sign-in in
_COOKIE_DBS = ("Default/Network/Cookies", "Default/Cookies")  # where Chrome keeps cookies: newer, then older
# Where Chrome notes the open tabs' pages for session restore: newer, then older.
_SESSION_FILES = ("Default/Sessions/Session_*", "Default/Sessions/Tabs_*", "Default/Current Session", "Default/Current Tabs")
_SIGNED_OUT_PATHS = ("/login", "/magic-link", "/oauth", "/api/")  # pages of the site a signed-out tab can be on
_URL = re.compile(rb"https?://[A-Za-z0-9.\-]+(?::\d+)?/[^\x00-\x20\"'<>]*")
DRIVEN_CHECK_WAIT = 30.0  # seconds a driven window gets for the site's security check to pass by itself
CHALLENGE_PATIENCE = 600.0  # seconds the person gets to pass that check in a plain window
LOAD_BATCH = 4 * 1024 * 1024  # bytes of file per round trip when loading an export into a page
CHUNK = 1024 * 1024

Say = Callable[[str], None]


def _quiet(_: str) -> None:
    pass


# ---------------------------------------------------------------------------
# Accounts, profiles and remembered settings
# ---------------------------------------------------------------------------


@dataclass
class Account:
    """One side of the move: who should be signed in, and the profile it uses."""

    role: str  # "source" or "destination"
    label: str  # what the account was given as: a slot number, an email
    email: str = ""  # the account's email when cswap knows it
    org: str = ""  # the uuid of the account's organization when cswap knows it

    @property
    def shown(self) -> str:
        return self.email or self.label

    def profile_dir(self, root: Path) -> Path:
        return root / PROFILES_DIR / profile_name(self.email or self.label)


def profile_name(value: str) -> str:
    """A folder name for an account's browser profile."""
    name = re.sub(r"[^A-Za-z0-9@._-]+", "_", value.strip().lower()).strip("._")
    if not name:
        raise ValidationError("An account is needed for each side: --from and --to.")
    return name


@dataclass
class AutoSettings:
    """What ``auto`` remembers between runs, so a later run needs no options."""

    source: str = ""
    destination: str = ""
    project: str = ""
    into: str = ""  # the project an import stopped part-way in, for the next run to carry on in

    @classmethod
    def load(cls, root: Path) -> "AutoSettings":
        try:
            raw = json.loads((root / SETTINGS_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cls()
        if not isinstance(raw, dict):
            return cls()
        return cls(**{k: raw[k] for k in ("source", "destination", "project", "into") if isinstance(raw.get(k), str)})

    def save(self, root: Path) -> None:
        root.mkdir(parents=True, exist_ok=True)
        path = root / SETTINGS_FILE
        tmp = path.with_suffix(".json.tmp")
        payload = {"source": self.source, "destination": self.destination, "project": self.project, "into": self.into}
        tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Which page shows the project
# ---------------------------------------------------------------------------

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_TAGGED = re.compile(r"^[a-z]+_[0-9A-Za-z]{8,}$")


def project_page(site: str, project: str) -> tuple[str, str]:
    """``(page to open, name to pick)`` for how the project was given.

    A claude.ai address is opened as it is; a project id is turned into its
    page; anything else is a name, picked from the export script's list of
    projects (an empty one is fine when the account has a single project).
    """
    value = (project or "").strip()
    site = site.rstrip("/")
    if value.startswith(("https://", "http://")):
        if not value.startswith(site + "/") and value != site:
            raise ValidationError(f"{value} is not a page of {site}.")
        return value, ""
    if _TAGGED.match(value):
        return f"{site}/code/project/{value}", ""
    if _UUID.match(value):
        return f"{site}/project/{value}", ""
    return f"{site}/projects", value


# ---------------------------------------------------------------------------
# The page helper
# ---------------------------------------------------------------------------


def helper_text() -> str:
    source = resources.files("claude_swap") / pm.SCRIPT_DIR / "automation.js"
    return source.read_text(encoding="utf-8").replace("\r\n", "\n").strip()


def install_helper(page: Page, mode: str, *, project: str = "", name: str = "") -> None:
    """Put ``automation.js`` in the page, set up for an export or an import."""
    orgs = page.evaluate(
        "fetch('/api/organizations', {credentials: 'include', headers: {Accept: 'application/json'}})"
        ".then(r => r.ok ? r.json() : []).then(v => (Array.isArray(v) ? v : [])"
        ".map(o => ({uuid: o && o.uuid, name: o && o.name}))).catch(() => [])",
        timeout=30,
    )
    config = {
        "mode": mode,
        "binding": BINDING,
        "project": project or "",
        "name": name or "",
        "orgs": orgs or [],
    }
    page.evaluate(f"({helper_text()})({json.dumps(config)})", timeout=30)


def page_state(page: Page) -> dict:
    value = page.evaluate("window.__cswap ? window.__cswap.state() : null", await_promise=False, timeout=30)
    if not isinstance(value, dict):
        raise BrowserError("the page was reloaded while the script was running")
    return value


class Interrupted(BrowserError):
    """A step stopped before its end, for a reason that is not the step's own.

    ``checked``: the site's security check took the window (it is the
    person's to pass, in a plain window; see ``_person_passes_check``).
    ``gone``: the window or its tab went away (opening it again may do).
    ``url``: the project the import had made by then, so that a later run
    can carry on in it instead of making a second one. ``export`` is set
    on the way out of ``move`` to the export the import was given.
    """

    def __init__(self, message: str, *, url: str = "", checked: bool = False, gone: bool = False):
        super().__init__(message)
        self.url = url
        self.checked = checked
        self.gone = gone
        self.export: pm.ExportCheck | None = None


# ---------------------------------------------------------------------------
# Signing in, once per account
# ---------------------------------------------------------------------------

_SIGNED_IN = """(async () => {
  if (location.origin !== %(origin)s) return {page: location.href};
  let orgs = [];
  try {
    const r = await fetch('/api/organizations', {credentials: 'include', headers: {Accept: 'application/json'}});
    if (!r.ok) return {page: location.href, status: r.status};
    const v = await r.json();
    if (Array.isArray(v)) orgs = v.map(o => o && o.uuid).filter(u => typeof u === 'string');
  } catch (e) {
    return {page: location.href, error: String(e)};
  }
  let email = '';
  for (const path of ['/api/account', '/api/auth/current_account']) {
    try {
      const r = await fetch(path, {credentials: 'include', headers: {Accept: 'application/json'}});
      if (!r.ok) continue;
      const a = await r.json();
      const got = a && (a.email_address || a.email || (a.account && (a.account.email_address || a.account.email)));
      if (typeof got === 'string' && got.includes('@')) { email = got; break; }
    } catch (e) {}
  }
  return {page: location.href, signedIn: orgs.length > 0, email, orgs};
})()"""


# The site's security check (Cloudflare's), as it shows in a tab: its page,
# its title, its words, or its widget.
_CHALLENGE = """(() => {
  if (location.pathname.startsWith('/api/challenge_redirect')) return true;
  if ((document.title || '').toLowerCase().includes('just a moment')) return true;
  const text = ((document.body && document.body.innerText) || '').toLowerCase();
  for (const words of ['performing security verification', 'verifies you are not a bot',
                       'security service to protect against malicious bots', 'verify you are human',
                       'checking your browser']) {
    if (text.includes(words)) return true;
  }
  return !!document.querySelector(
    '#challenge-running, #challenge-stage, #challenge-form, #cf-chl-widget, iframe[src*="challenges.cloudflare.com"]');
})()"""


def _challenged(page: Page) -> bool:
    """Whether the tab is on the site's security check."""
    try:
        return bool(page.evaluate(_CHALLENGE, await_promise=False, timeout=10))
    except PageClosed:
        raise
    except BrowserError:
        return False  # between pages


def _pass_challenge(page: Page, say: Say = _quiet, patience: float | None = None) -> bool:
    """Wait for the site's security check, when the tab is on it, to pass; returns whether it was there.

    The check is the site's to run and the person's to answer, and cswap
    does nothing to it: it waits ``patience`` seconds (``DRIVEN_CHECK_WAIT``)
    for a check that passes by itself, and then raises ``Interrupted`` so
    that the person can pass it in a plain window instead. (Ticking the
    box in a driven window only brings the check back.)
    """
    if not _challenged(page):
        return False
    wait = DRIVEN_CHECK_WAIT if patience is None else patience
    say(
        'claude.ai is running its security check in that window ("Performing security verification"). '
        f"Leave the window alone: cswap gives the check {wait:.0f} seconds to pass by itself, and "
        "otherwise opens a normal window for you to pass it in."
    )
    deadline = time.monotonic() + wait
    while _challenged(page):
        if time.monotonic() > deadline:
            raise Interrupted(
                "claude.ai's security check did not pass in that window, and cswap does not try to get around it",
                checked=True,
            )
        page.pump(2.0)
    say("The security check passed; carrying on.")
    return True


@dataclass
class SignedIn:
    """What the site says about the sign-in a window holds."""

    signed_in: bool
    email: str = ""
    orgs: tuple[str, ...] = ()  # uuids of the organizations that sign-in belongs to

    def matches(self, account: Account) -> bool | None:
        """Whether this is ``account``'s sign-in; None when the site does not say whose it is.

        The email decides when the site gives one. Otherwise an account cswap
        holds is known by its organization, which the site always lists.
        """
        if not self.signed_in:
            return False
        if self.email and account.email:
            return self.email.lower() == account.email.lower()
        if self.orgs and account.org:
            return account.org.lower() in {org.lower() for org in self.orgs}
        return None


@dataclass
class Window:
    """One account's browser window, and the tab cswap works in."""

    account: Account
    browser: Browser
    page: Page
    signed_in_as: str = ""

    def close(self) -> None:
        try:
            self.page.close()
        except Exception:
            pass
        if self.browser.launched:
            self.browser.close()


def open_window(
    account: Account,
    root: Path,
    site: str,
    executable: str,
    *,
    headless: bool = False,
    extra_args: list[str] | None = None,
) -> Window:
    """Start (or join) this account's browser with its DevTools port, on a tab at ``site``."""
    profile = account.profile_dir(root)
    browser = Browser.start(executable, profile, site + "/", headless=headless, extra_args=extra_args)
    tab = browser.tab(prefer=site)
    page = browser.connect(tab)
    # The tab list gives the address a tab was opened for, not the one it
    # shows: headless Chrome for Testing 154 on Windows and macOS lists the
    # start URL while the tab stays on about:blank. So the page itself is asked.
    href, _ = page.location()
    if not (str(tab.get("url", "")).startswith(site) and href.startswith(site)):
        page.navigate(site + "/")
    return Window(account=account, browser=browser, page=page)


def _js(value: str) -> str:
    return json.dumps(value)


def who_is_signed_in(page: Page, site: str, timeout: float = 60.0, say: Say = _quiet) -> SignedIn:
    """Whether the page's profile is signed in to ``site``, and as whom when the site says.

    The site's security check, when the tab is on it, is waited out first
    (see ``_pass_challenge``): a tab on the check looks signed out otherwise.
    """
    page.wait_loaded(site, timeout=timeout)
    origin = _js(site.rstrip("/"))
    deadline = time.monotonic() + timeout
    while True:
        if _pass_challenge(page, say):
            page.wait_loaded(site, timeout=timeout)
            deadline = time.monotonic() + timeout
        try:
            info = page.evaluate(_SIGNED_IN % {"origin": origin}, timeout=30)
        except EvaluationError:
            info = None
        except PageClosed:
            raise
        except BrowserError:
            info = None  # between pages
        if isinstance(info, dict) and "signedIn" in info:
            orgs = tuple(org for org in (info.get("orgs") or ()) if isinstance(org, str))
            return SignedIn(bool(info["signedIn"]), str(info.get("email") or ""), orgs)
        if isinstance(info, dict) and info.get("status") in (401, 403):
            return SignedIn(False)
        if time.monotonic() > deadline:
            return SignedIn(False)
        page.pump(1.0)


def _remember(account: Account, root: Path, *, verified: bool) -> None:
    """Note in the profile whose sign-in it holds, for the times the site does not say."""
    note = {"account": account.shown, "verified": verified, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    try:
        profile = account.profile_dir(root)
        profile.mkdir(parents=True, exist_ok=True)
        (profile / SIGN_IN_FILE).write_text(json.dumps(note) + "\n", encoding="utf-8")
    except OSError:
        pass


def _remembered(account: Account, root: Path) -> bool:
    """Whether the person signed in to this profile for ``account`` on an earlier run."""
    try:
        raw = json.loads((account.profile_dir(root) / SIGN_IN_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(raw, dict) and raw.get("account") == account.shown


def _whose(found: SignedIn, verdict: bool | None) -> str:
    """Whose sign-in the site found, for a message; empty when it did not say."""
    if found.email:
        return f"as {found.email}"
    return "as another account" if verdict is False else ""


_LABEL_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(title)s</title>
%(refresh)s<style>
  body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; color: #111; background: #fff; }
  .band { background: #1a56db; color: #fff; padding: 28px 40px; font-size: 24px; }
  .band b { display: block; margin-top: 10px; font-size: 40px; word-break: break-all; }
  main { padding: 32px 40px; font-size: 24px; line-height: 1.5; max-width: 60em; }
  a.go { display: inline-block; margin: 8px 0 24px; padding: 18px 32px; border-radius: 10px;
         background: #1a56db; color: #fff; font-size: 28px; font-weight: 600; text-decoration: none; }
  a.go:hover { background: #1443b0; }
  p { margin: 0 0 16px; }
</style>
</head>
<body>
<div class="band">cswap: this window is for the %(role)s account<b>%(who)s</b></div>
<main>
<p><a class="go" href="%(go)s">%(button)s</a></p>
%(body)s</main>
</body>
</html>
"""

_SIGN_IN_BODY = """<p>Sign in there as <b>%(who)s</b> and nobody else.</p>
<p>You can leave this window open: a few seconds after you are signed in,
cswap closes it. Closing it yourself works too.</p>
"""

_CHECK_BODY = """<p>claude.ai wants to make sure that a person is using this browser before it
lets cswap work in it, and its check does not pass in the window cswap drives.
Open claude.ai with the button; if the check shows a box to tick, tick it.</p>
<p>You can leave this window open: a few seconds after claude.ai shows,
cswap closes it and carries on. Closing it yourself then works too.</p>
"""


def label_page(
    account: Account, site: str, root: Path, continue_after: float | None = None, *, check: bool = False
) -> str:
    """Write the page a plain window opens on, and return its address.

    That window has nothing attached that could label it, so the page does:
    it says in large blue text which account the window is for, with a
    button to the site's sign-in page, or, with ``check``, to the site
    itself, for the person to pass its security check there. With
    ``continue_after`` the page goes on by itself after that many seconds
    (the tests have nobody to press the button).
    """
    who = account.shown
    go = site.rstrip("/") + ("/" if check else "/login")
    refresh = ""
    if continue_after is not None:
        refresh = f'<meta http-equiv="refresh" content="{continue_after:g};url={html.escape(go)}">\n'
    vars = {"who": html.escape(who), "role": html.escape(account.role.upper())}
    text = _LABEL_PAGE % {
        **vars,
        "title": f"Pass claude.ai's check as {vars['who']} ({vars['role']})" if check else f"Sign in as {vars['who']} ({vars['role']})",
        "go": html.escape(go),
        "button": f"Open claude.ai as {vars['who']}" if check else f"Sign in to claude.ai as {vars['who']}",
        "body": (_CHECK_BODY if check else _SIGN_IN_BODY) % vars,
        "refresh": refresh,
    }
    folder = root / PROFILES_DIR
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (profile_name(account.email or account.label) + (CHECK_SUFFIX if check else LABEL_SUFFIX))
    path.write_bytes(text.encode("ascii", "xmlcharrefreplace"))
    return path.resolve().as_uri()


Wait = Callable[[subprocess.Popen], None]


def _cookie_db(profile: Path) -> Path | None:
    for rel in _COOKIE_DBS:
        path = profile / rel
        if path.is_file():
            return path
    return None


def session_cookies(profile: Path, host: str) -> set[tuple]:
    """The site's sign-in cookies in the profile, as rows that tell one from another.

    Chrome keeps cookies in an SQLite file that it writes about half a
    minute after a change. Only the cookie's name, host and creation time
    are read, never its value, which is encrypted anyway. Anything that
    goes wrong (the file is mid-write, or the layout differs) reads as no
    cookies, and the next look may do better.
    """
    db = _cookie_db(profile)
    if db is None:
        return set()
    host = host.lower()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / "Cookies"
            for suffix in ("", "-wal", "-shm"):
                source = Path(str(db) + suffix)
                if source.is_file():
                    Path(str(copy) + suffix).write_bytes(source.read_bytes())
            # Read-write, on the copy: a read-only open cannot recover a
            # write-ahead log, which Chrome may leave without its -shm file.
            con = sqlite3.connect(copy)
            try:
                rows = con.execute(
                    "SELECT host_key, value, encrypted_value, creation_utc FROM cookies WHERE name = ?",
                    (SESSION_COOKIE,),
                ).fetchall()
            finally:
                con.close()
    except (OSError, sqlite3.Error):
        return set()
    return {
        (str(h), str(v or ""), bytes(e or b""), int(c or 0))
        for h, v, e, c in rows
        if str(h).lower().lstrip(".") == host or str(h).lower().endswith("." + host)
    }


def session_files(profile: Path) -> dict[str, tuple[int, int]]:
    """The profile's session-restore files, each with its size and modification time."""
    found: dict[str, tuple[int, int]] = {}
    for pattern in _SESSION_FILES:
        for path in profile.glob(pattern):
            try:
                if path.is_file():
                    stat = path.stat()
                    found[str(path)] = (stat.st_size, stat.st_mtime_ns)
            except OSError:
                continue
    return found


def session_pages(profile: Path, before: dict[str, tuple[int, int]]) -> list[str]:
    """The pages the tabs of a new browser session have been on.

    Chrome notes every page a tab lands on in its session-restore files a
    few seconds after the fact, in plain text, in files of that browser
    session's own. ``before`` is ``session_files`` as it was before the
    browser started: files it lists, untouched since, belong to earlier
    sessions and are left alone. A file that cannot be read counts as empty.
    """
    pages: list[str] = []
    for path, stamp in sorted(session_files(profile).items()):
        if before.get(path) == stamp:
            continue
        try:
            data = Path(path).read_bytes()
        except OSError:
            continue
        commands = _snss_commands(data)
        if commands is None:
            pages.extend(m.decode("latin-1") for m in _URL.findall(data))
            continue
        for payload in commands:
            # A navigation's record holds the page the tab is on first,
            # and after it the page that was asked for, which a redirect
            # (the site's security check, say) may have turned into
            # another: only the first counts.
            match = _URL.search(payload)
            if match:
                pages.append(match.group(0).decode("latin-1"))
    return pages


def _snss_commands(data: bytes) -> list[bytes] | None:
    """The commands of a session-restore file, by payload (a size, a kind, the rest); None for another file."""
    if data[:4] != b"SNSS":
        return None
    commands = []
    pos = 8  # past the magic and the version
    while pos + 3 <= len(data):
        size = int.from_bytes(data[pos : pos + 2], "little")
        pos += 2
        if size < 1 or pos + size > len(data):
            break
        commands.append(data[pos + 1 : pos + size])
        pos += size
    return commands or None  # nothing readable as a command: the file is read whole instead


def signed_in_page(pages: list[str], host: str) -> str:
    """The first of ``pages`` on ``host`` that only a signed-in tab can be on, or ""."""
    host = host.lower()
    for page in pages:
        parts = urlsplit(page)
        if (parts.hostname or "").lower() != host:
            continue
        if any(parts.path.startswith(prefix) for prefix in _SIGNED_OUT_PATHS):
            continue
        return page
    return ""


def _close_gently(process, timeout: float = 15.0) -> None:
    """Close the plain window the way a person would, so the browser saves its state first.

    A sign-in made moments ago lives only in the browser's memory until it
    shuts down properly: SIGTERM makes Chrome exit at once without saving
    it, SIGINT and the window's close button (WM_CLOSE) both make it save.
    """
    if process.poll() is not None:
        return
    asked = False
    if sys.platform == "win32":
        for command in (
            ["powershell", "-NoProfile", "-Command", f"(Get-Process -Id {process.pid}).CloseMainWindow()"],
            ["taskkill", "/PID", str(process.pid)],  # without /F: WM_CLOSE to its windows
        ):
            try:
                done = subprocess.run(command, capture_output=True, text=True, timeout=30)
            except (OSError, subprocess.SubprocessError):
                continue
            if done.returncode == 0 and "False" not in done.stdout:
                asked = True
                break
    else:
        try:
            process.send_signal(signal.SIGINT)
            asked = True
        except OSError:
            pass
    if not asked:
        process.terminate()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=timeout)


def _wait_for_sign_in(
    process,
    profile: Path,
    host: str,
    cookies_before: set,
    files_before: dict[str, tuple[int, int]],
    deadline: float,
    say: Say = _quiet,
    poll: float = 1.0,
    what: str = "sign-in",
) -> None:
    """Wait until the plain window is gone: closed by the person, or by us once the sign-in is in.

    The sign-in shows in two ways, and either will do: a tab of the new
    browser session has landed on a page of the site that only a signed-in
    tab can be on, or the site's sign-in cookie has reached the profile's
    cookie store (where that can be read while the browser runs; Windows
    keeps it locked). ``cookies_before`` and ``files_before`` are what
    ``session_cookies`` and ``session_files`` found before the window
    opened, so that neither a stale sign-in cookie nor an earlier session's
    pages count. With ``what`` set to "check" the window is the one the
    person passes the site's security check in, which shows the same way:
    a tab lands on a page of the site past the check.
    """
    while process.poll() is None:
        if time.monotonic() > deadline:
            raise BrowserError(
                "The check did not pass in that window in time. Close it and run this again later."
                if what == "check"
                else "Nobody signed in there in time. Run this again, and sign in in the window it opens."
            )
        if signed_in_page(session_pages(profile, files_before), host) or session_cookies(profile, host) - cookies_before:
            say("claude.ai shows there: the check passed. Closing that window..." if what == "check" else "Signed in. Closing that window...")
            _close_gently(process)
            return
        time.sleep(poll)


def _person_passes_check(
    account: Account,
    root: Path,
    site: str,
    executable: str,
    *,
    say: Say = _quiet,
    headless: bool = False,
    extra_args: list[str] | None = None,
    wait: Wait | None = None,
    label_seconds: float | None = None,
    patience: float = CHALLENGE_PATIENCE,
) -> None:
    """Open the account's profile in a plain window for the person to pass the site's security check.

    The check tells people from automation, and in a driven window it does
    not pass however often its box is ticked. cswap does not touch it: the
    driven window is closed first (the caller's job), the profile opens in
    a window with nothing attached, on a page saying what to do, the
    person passes the check there as they would in any browser, and once
    a tab of theirs is on the site past the check the window is closed and
    the profile opened driven again, carrying the pass with it. A check
    that comes straight back in the driven window is where cswap stops.
    """
    role = account.role.upper()
    say(
        f"That check does not pass in a driven window. A normal browser window just opened for {account.shown} "
        f"(the {role} account) instead; it says so in blue. Use its button to open claude.ai and, if the check "
        "shows a box to tick, tick it. A few seconds after claude.ai shows, the window closes by itself and "
        "cswap carries on (closing it yourself then is fine too)."
    )
    profile = account.profile_dir(root)
    host = urlsplit(site).hostname or site
    cookies_before = session_cookies(profile, host)
    files_before = session_files(profile)
    process = launch_plain(
        executable,
        profile,
        label_page(account, site, root, continue_after=label_seconds, check=True),
        headless=headless,
        extra_args=extra_args,
    )
    if wait is not None:
        wait(process)
    else:
        _wait_for_sign_in(
            process, profile, host, cookies_before, files_before, time.monotonic() + patience, say, what="check"
        )
    time.sleep(1.0)  # the profile is released a moment after the window goes
    say(f"Opening the {account.shown} window again.")


def sign_in(
    account: Account,
    root: Path,
    site: str,
    executable: str,
    *,
    timeout: float = 1800,
    say: Say = _quiet,
    headless: bool = False,
    extra_args: list[str] | None = None,
    wait: Wait | None = None,
    label_seconds: float | None = None,
) -> Window:
    """A driven window signed in to ``site`` as ``account``.

    When the profile already holds that sign-in, this is quick and silent.
    Otherwise the profile is opened in a plain window first, with no
    DevTools port, since Google will not sign in to a browser that has one
    open: the person signs in there, the window is closed (by cswap once the
    site's sign-in cookie reaches the profile, or by the person), and the
    profile is then opened again with the port. That window opens on a page
    naming the account it is for, with a button to the sign-in page (see
    ``label_page``). A profile found signed in as someone else, or as nobody
    the site will name, is signed out first (the profile is dropped), so the
    sign-in page is always what the button leads to; and a sign-in the
    person then makes as another account is refused, signed out again.
    ``wait`` replaces waiting for the plain window to be closed, and
    ``label_seconds`` makes the page go on to the sign-in by itself (the
    tests sign in and close the window themselves).
    """
    deadline = time.monotonic() + timeout
    role = account.role.upper()
    asked = False
    checked = False
    while True:
        window = open_window(account, root, site, executable, headless=headless, extra_args=extra_args)
        try:
            found = who_is_signed_in(window.page, site, say=say)
        except Interrupted as e:
            window.close()
            if not e.checked:
                raise
            if checked:
                raise Interrupted(_checked_again(account), checked=True) from None
            checked = True
            _person_passes_check(
                account, root, site, executable, say=say, headless=headless, extra_args=extra_args,
                wait=wait, label_seconds=label_seconds,
            )
            continue
        except BaseException:
            window.close()
            raise
        verdict = found.matches(account)
        if verdict is None and not asked and _remembered(account, root):
            verdict = True  # the person signed in here for this account, and the site cannot say otherwise
        if verdict is True or (verdict is None and asked):
            window.signed_in_as = found.email or account.shown
            _remember(account, root, verified=verdict is True)
            if asked and verdict is True:
                say(f"Signed in as {window.signed_in_as} ({account.role}).")
            elif asked:
                say(
                    f"Signed in for {account.shown} ({account.role}). claude.ai did not say as whom, "
                    f"so that sign-in is taken as {account.shown}'s; `--fresh` forgets it."
                )
            return window

        # Not the right sign-in. The driven browser must be out of the way:
        # a profile is open in one browser at a time.
        try:
            window.page.close()
        except Exception:
            pass
        window.browser.close()

        if found.signed_in:
            # Someone else's sign-in, or one the site will not name: sign it
            # out, by dropping the profile, so the window opens on the sign-in page.
            whose = _whose(found, verdict)
            _drop_profile(account, root)
            if asked:
                raise ValidationError(
                    f"You signed in {whose}, but that window was for {account.shown} (the {role} account). "
                    f"It is signed out again. Run this again and sign in there as {account.shown}."
                )
            say(
                f"The {account.shown} window was signed in {whose}. Signed it out."
                if whose
                else f"The {account.shown} window was signed in, but claude.ai did not say as whom. Signed it out."
            )
        if time.monotonic() > deadline:
            raise BrowserError(f"Nobody signed in as {account.shown} in time. Run this again to keep waiting.")

        say(
            f"A browser window just opened for {account.shown} (the {role} account); it says so in blue. "
            f"Use its button to sign in to claude.ai as {account.shown}. A few seconds after you are "
            "signed in, the window closes by itself (closing it yourself is fine too)."
        )
        asked = True
        profile = account.profile_dir(root)
        host = urlsplit(site).hostname or site
        # What is there already is not the sign-in we wait for.
        cookies_before = session_cookies(profile, host)
        files_before = session_files(profile)
        process = launch_plain(
            executable,
            profile,
            label_page(account, site, root, continue_after=label_seconds),
            headless=headless,
            extra_args=extra_args,
        )
        if wait is not None:
            wait(process)
        else:
            _wait_for_sign_in(process, profile, host, cookies_before, files_before, deadline, say)
        time.sleep(1.0)  # the profile is released a moment after the window goes
        say(f"Checking the sign-in for {account.shown}...")


# ---------------------------------------------------------------------------
# Export: the source window writes, this side saves
# ---------------------------------------------------------------------------


def _long(path: Path) -> str:
    """``path`` in a form Windows does not cut off at 260 characters."""
    if sys.platform != "win32":
        return str(path)
    full = os.path.abspath(str(path))
    if full.startswith("\\\\?\\"):
        return full
    if full.startswith("\\\\"):
        return "\\\\?\\UNC\\" + full[2:]
    return "\\\\?\\" + full


class ExportWriter:
    """Saves the files the page sends, under ``folder``.

    The export script puts everything in one folder named after the project.
    If the exports folder already has one of that name, this export gets a
    name of its own (``name (2)``) instead of being mixed into the old one.
    """

    def __init__(self, folder: Path):
        self.folder = folder
        self.tops: dict[str, str] = {}  # the script's top folder -> the one used
        self.open: dict[int, object] = {}
        self.files = 0
        self.bytes = 0
        self.error = ""

    def _top(self, name: str) -> str:
        if name not in self.tops:
            chosen, n = name, 1
            while (self.folder / chosen).exists():
                n += 1
                chosen = f"{name} ({n})"
            self.tops[name] = chosen
        return self.tops[name]

    def target(self, relative: str) -> Path:
        parts = relative.split("/")
        if pm._inside(self.folder, relative) is None:
            raise ValueError(f"refused an unsafe path from the page: {relative!r}")
        if len(parts) > 1:
            parts[0] = self._top(parts[0])
        return self.folder.joinpath(*parts)

    @property
    def exports(self) -> list[Path]:
        return [self.folder / name for name in self.tops.values()]

    def on_binding(self, params: dict) -> None:
        if params.get("name") != BINDING:
            return
        try:
            message = json.loads(params.get("payload") or "{}")
            self._write(message)
        except Exception as e:  # noqa: BLE001 - reported once the export ends
            if not self.error:
                self.error = f"could not save a file: {e}"

    def _write(self, message: dict) -> None:
        if message.get("op") != "file":
            return
        ident = int(message["id"])
        data = base64.b64decode(message.get("data") or "")
        if message.get("seq") == 0:
            path = self.target(str(message["path"]))
            os.makedirs(_long(path.parent), exist_ok=True)
            self.open[ident] = open(_long(path), "wb")  # noqa: SIM115 - closed on the last chunk
        handle = self.open.get(ident)
        if handle is None:
            raise ValueError(f"a piece of {message.get('path')!r} arrived out of order")
        handle.write(data)  # type: ignore[attr-defined]
        self.bytes += len(data)
        if message.get("last"):
            handle.close()  # type: ignore[attr-defined]
            del self.open[ident]
            self.files += 1

    def close(self) -> None:
        for handle in self.open.values():
            handle.close()  # type: ignore[attr-defined]
        self.open.clear()


def _settle(page: Page, seconds: float) -> None:
    """Let the page's own start-up requests run (the export reads them)."""
    page.pump(seconds)


def _run_script(page: Page, stage: str) -> None:
    try:
        page.evaluate(pm.script_text(stage), timeout=600)
    except EvaluationError as e:
        raise BrowserError(f"The {stage} script could not start: {e}") from None


def _follow(
    page: Page,
    say: Say,
    *,
    timeout: float,
    fail_words: tuple[str, ...],
    what: str = "script",
    link_from: Callable[[], str] = lambda: "",
) -> dict:
    """Press the script's button, then report its status lines until it ends.

    A stop that is not the script's own (its tab closed, or the site's
    security check taking the window over, which the site does by sending
    the tab to the check page) is raised as ``Interrupted``, with the link
    the script had shown by then (``link_from`` gives one the page sent
    on its own), so that an import can be carried on in the project it made.
    """
    state = page_state(page)
    if not state.get("ready"):
        errors = "; ".join(state.get("errors") or []) or "its button did not appear"
        raise BrowserError(f"The script did not get ready: {errors}")
    page.evaluate("window.__cswap.press()", await_promise=False)
    last = ""
    link = ""
    deadline = time.monotonic() + timeout
    while True:
        try:
            page.pump(0.5)
            state = page_state(page)
        except PageClosed as e:
            raise Interrupted(f"the window went away ({e})", url=link or link_from(), gone=True) from None
        except BrowserError:
            # The script's page is gone. Where the tab went takes a moment
            # to load, so it is looked at a few times before it counts as
            # just reloaded.
            link = link or link_from()
            for _ in range(5):
                try:
                    page.pump(1.0)
                    checked = _challenged(page)
                except PageClosed as e:
                    raise Interrupted(f"the window went away ({e})", url=link, gone=True) from None
                if checked:
                    raise Interrupted(
                        f"claude.ai's security check took that window over in the middle of the {what}",
                        url=link,
                        checked=True,
                    ) from None
            raise Interrupted(f"the page was reloaded in the middle of the {what}", url=link) from None
        link = state.get("link") or link_from() or link
        status = state.get("status") or ""
        if status and status != last:
            say(f"  {status}")
            last = status
        if state.get("cancelled"):
            return state
        if state.get("done"):
            return state
        if status.startswith(fail_words):
            return state
        if time.monotonic() > deadline:
            raise BrowserError(f"The {what} did not finish in time. Its window is left open.")


# The Claude Code projects (channels) the signed-in account is in, as
# [id, name] pairs. The export script cannot list these, so a Claude Code
# project given by name is looked up here and opened by its address.
_CODE_PROJECTS = """(async () => {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const url = '/v1/code/channels?scope=joined&include_archived=true&limit=200' +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    let r;
    try {
      r = await fetch(url, {credentials: 'include', headers: {Accept: 'application/json', 'anthropic-version': '2023-06-01'}});
    } catch (e) {
      break;
    }
    if (!r.ok) break;
    const v = await r.json();
    const rows = Array.isArray(v) ? v : (v && (v.data || v.channels)) || [];
    for (const c of rows) {
      const id = c && (c.id || c.uuid);
      const name = c && (c.name || c.title || c.topic);
      if (typeof id === 'string' && typeof name === 'string') out.push([id, name]);
    }
    cursor = v && v.next_cursor;
    if (!cursor || !rows.length) break;
  }
  return out;
})()"""


def find_code_project(page: Page, name: str) -> tuple[str, list[str]]:
    """The id of the Claude Code project called ``name``, and every such project's name."""
    try:
        rows = page.evaluate(_CODE_PROJECTS, timeout=120) or []
    except EvaluationError:
        rows = []
    pairs = [(str(r[0]), str(r[1])) for r in rows if isinstance(r, list) and len(r) == 2]
    names = [n for _, n in pairs]
    want = name.strip().lower()
    if not want:
        return "", names
    exact = [i for i, n in pairs if n.strip().lower() == want]
    if len(exact) == 1:
        return exact[0], names
    partial = [i for i, n in pairs if want in n.lower()]
    if not exact and len(partial) == 1:
        return partial[0], names
    return "", names


def run_export(window: Window, site: str, project: str, folder: Path, say: Say = _quiet, timeout: float = 4 * 3600) -> pm.ExportCheck:
    """Export the project in the source window into ``folder``; returns the checked export."""
    url, name = project_page(site, project)
    page = window.page
    _pass_challenge(page, say)
    code_names: list[str] = []
    if name:
        found, code_names = find_code_project(page, name)
        if found:
            url, name = project_page(site, found)
    say(f"Opening {url} in the source window.")
    page.navigate(url)
    page.wait_loaded(site)
    _pass_challenge(page, say)
    _settle(page, 4.0)

    folder.mkdir(parents=True, exist_ok=True)
    writer = ExportWriter(folder)
    page.handlers["Runtime.bindingCalled"] = writer.on_binding
    page.call("Runtime.enable")
    page.call("Runtime.addBinding", {"name": BINDING})
    try:
        install_helper(page, "export", project=name)
        _run_script(page, "export")
        state = _follow(page, say, timeout=timeout, fail_words=("Export failed",), what="export")
        page.pump(0.5)  # anything still on its way
    finally:
        writer.close()
        page.handlers.pop("Runtime.bindingCalled", None)

    if state.get("cancelled"):
        choices = list(state.get("choices") or [])
        choices += [f"{n}  [code]" for n in code_names if n not in choices]
        listed = ("\nProjects this account has:\n" + "\n".join(f"  {c}" for c in choices)) if choices else ""
        raise ValidationError(
            f"{state['cancelled']} Name it with: cswap project-move auto \"NAME\" (or paste its claude.ai address).{listed}"
        )
    if not state.get("done"):
        raise BrowserError(state.get("status") or "The export did not finish.")
    if writer.error:
        raise BrowserError(f"The export ran, but {writer.error}.")
    if not writer.exports:
        raise BrowserError("The export finished without saving anything.")
    export = pm.read_export(writer.exports[0])
    if not export.complete:
        what = export.error or ", ".join((export.missing + export.wrong_size)[:5])
        raise BrowserError(f"The export in {export.path} is not complete: {what}")
    say(
        f"Saved {export.files} project file(s) and {export.conversations} conversation(s) "
        f"({writer.files} files, {pm.size_text(writer.bytes)} in all) to {export.path}"
    )
    return export


# ---------------------------------------------------------------------------
# Import: this side loads the export into the destination window
# ---------------------------------------------------------------------------


def export_files(path: Path) -> list[tuple[str, Path]]:
    """Every file in an export folder, as ``(path with /, file)``."""
    out = []
    for dirpath, _dirs, names in os.walk(path):
        for n in sorted(names):
            full = Path(dirpath) / n
            out.append((full.relative_to(path).as_posix(), full))
    out.sort()
    return out


def load_export(page: Page, path: Path) -> int:
    """Put every file of the export into the page; returns the bytes sent."""
    batch: list[list] = []
    size = 0
    total = 0

    def flush() -> None:
        nonlocal batch, size
        if batch:
            page.evaluate(
                f"(() => {{ for (const [p, d, a] of {json.dumps(batch)}) window.__cswap.addFile(p, d, a); return true; }})()",
                await_promise=False,
                timeout=120,
            )
        batch, size = [], 0

    for relative, full in export_files(path):
        with open(_long(full), "rb") as fh:
            first = True
            while True:
                piece = fh.read(CHUNK)
                if not piece and not first:
                    break
                batch.append([relative, base64.b64encode(piece).decode("ascii"), not first])
                size += len(piece)
                total += len(piece)
                first = False
                if size >= LOAD_BATCH:
                    flush()
                if len(piece) < CHUNK:
                    break
    flush()
    return total


def code_project_id(value: str) -> str:
    """The id of a Claude Code project given as its id or its address; '' for anything else."""
    text = value.strip()
    if _TAGGED.match(text) and text.startswith("chan_"):
        return text
    if text.startswith(("http://", "https://")):
        match = re.search(r"/code/project/(chan_[0-9A-Za-z_]{8,})(?:/|$)", urlsplit(text).path)
        if match:
            return match.group(1)
    return ""


def run_import(
    window: Window,
    site: str,
    export: pm.ExportCheck,
    name: str = "",
    say: Say = _quiet,
    timeout: float = 4 * 3600,
    *,
    into: str = "",
) -> str:
    """Import ``export`` in the destination window; returns the new project's address.

    With ``into`` (the address or id of a Claude Code project an earlier
    import of this export made, then stopped part-way in) the import
    carries on in that project: what it holds already is left alone, the
    rest is added, and its settings are applied.
    """
    page = window.page
    if into:
        project = code_project_id(into)
        if not project:
            raise ValidationError(f"{into} is not the address or id of a Claude Code project; the import cannot carry on in it.")
        say(f"Carrying on with the import in {site.rstrip('/')}/code/project/{project}: what it holds already is left alone.")
        name = project  # the script takes a project's id where a name would go
    _pass_challenge(page, say)
    page.navigate(site.rstrip("/") + "/")
    page.wait_loaded(site)
    _pass_challenge(page, say)
    _settle(page, 2.0)

    # The page sends the new project's address the moment it has one, so
    # that an import stopped right after (the window gone before the next
    # look at it) still says where to carry on.
    seen = {"link": ""}

    def on_binding(params: dict) -> None:
        if params.get("name") != BINDING:
            return
        try:
            message = json.loads(params.get("payload") or "{}")
        except ValueError:
            return
        if isinstance(message, dict) and message.get("op") == "link" and isinstance(message.get("url"), str):
            seen["link"] = message["url"]

    page.handlers["Runtime.bindingCalled"] = on_binding
    page.call("Runtime.enable")
    page.call("Runtime.addBinding", {"name": BINDING})
    try:
        install_helper(page, "import", name=name)
        sent = load_export(page, export.path)
        say(f"Loaded the export into the destination window ({pm.size_text(sent)}).")
        _run_script(page, "import")
        state = _follow(
            page,
            say,
            timeout=timeout,
            fail_words=("Import failed", "The import stopped part-way", "Nothing was imported"),
            what="import",
            link_from=lambda: seen["link"],
        )
    finally:
        page.handlers.pop("Runtime.bindingCalled", None)
    if state.get("sourceVisible"):
        say(
            "Note: the destination account can see the project this came from. If both windows "
            "were meant to be different accounts, check which account the destination window uses."
        )
    if not state.get("done"):
        status = state.get("status") or "The import did not finish."
        if into and "is in view from this login" in status:
            status += " If it is gone, run this again with --new to make a new project."
        raise BrowserError(status)
    return state.get("link") or ""


def matching_export(folder: Path, project: str, remembered: str = "") -> pm.ExportCheck | None:
    """A complete export of ``project`` to import again, or None.

    ``remembered`` is the export the last run used (``MoveState.export_path``)
    and is taken when it is whole; otherwise the newest complete export in
    ``folder`` that is of this project (by its id, its address or its name;
    any export when ``project`` is empty). None means export again.
    """
    want_id = code_project_id(project) if project else ""
    want_name = "" if want_id else project.strip().lower()

    def fits(export: pm.ExportCheck) -> bool:
        if not export.complete:
            return False
        if not project:
            return True
        try:
            raw = json.loads((export.path / pm.MANIFEST_NAME).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        source = raw.get("source") if isinstance(raw, dict) else None
        source_id = str(source.get("id") or "") if isinstance(source, dict) else ""
        if want_id:
            return source_id == want_id
        return export.name.strip().lower() == want_name or source_id.lower() == want_name

    if remembered and (Path(remembered) / pm.MANIFEST_NAME).is_file():
        kept = pm.read_export(Path(remembered))
        if fits(kept):
            return kept
    for export in pm.check_folder(folder).exports:
        if fits(export):
            return export
    return None


# ---------------------------------------------------------------------------
# The whole move
# ---------------------------------------------------------------------------


@dataclass
class MoveResult:
    export: pm.ExportCheck | None = None
    url: str = ""


def forget(accounts: list[Account], root: Path, say: Say = _quiet) -> list[Path]:
    """Drop these accounts' browser profiles, sign-ins and all, so the next run asks again.

    The way out when a sign-in the site would not name was taken on trust
    as the wrong account's. A browser still open on a profile is closed
    first; a profile that does not exist is skipped.
    """
    gone: list[Path] = []
    for account in accounts:
        if _drop_profile(account, root):
            gone.append(account.profile_dir(root))
            say(f"Forgot the sign-in for {account.shown}.")
    return gone


def _drop_profile(account: Account, root: Path, tries: int = 10) -> bool:
    """Remove this account's browser profile, sign-in and all: False when there was none.

    A browser still open on it is closed first. Windows keeps a profile's
    files locked for a moment after the browser exits, hence the retries.
    """
    profile = account.profile_dir(root)
    if not profile.is_dir():
        return False
    port = Browser._reachable(profile)
    if port is not None:
        Browser(profile, port).close()
    for attempt in range(tries):
        shutil.rmtree(_long(profile), ignore_errors=True)
        if not profile.exists():
            return True
        if attempt + 1 < tries:
            time.sleep(0.5)
    raise BrowserError(f"Could not remove {profile}. Close every browser window that uses it and run this again.")


def sign_everyone_in(
    accounts: list[Account],
    root: Path,
    site: str,
    executable: str,
    *,
    timeout: float = 1800,
    say: Say = _quiet,
    headless: bool = False,
    extra_args: list[str] | None = None,
    wait: Wait | None = None,
    label_seconds: float | None = None,
) -> list[str]:
    """Sign each account in, one at a time with nothing else open; returns who is signed in.

    Each account's window is closed again once its sign-in is confirmed, so
    that no window sits around for the person to close by mistake while
    the next account signs in.
    """
    who: list[str] = []
    for account in accounts:
        window = sign_in(
            account,
            root,
            site,
            executable,
            timeout=timeout,
            say=say,
            headless=headless,
            extra_args=extra_args,
            wait=wait,
            label_seconds=label_seconds,
        )
        who.append(window.signed_in_as or account.shown)
        window.close()
    return who


def _checked_again(account: Account) -> str:
    return (
        f"claude.ai asked for its security check again in the {account.shown} window right after it passed in "
        "a normal window. cswap stops here rather than keep trying; run this again later"
    )


def _in_window(
    account: Account,
    signed_in_as: str,
    root: Path,
    site: str,
    executable: str,
    what: str,
    work: Callable[[Window, str], object],
    *,
    say: Say = _quiet,
    headless: bool = False,
    extra_args: list[str] | None = None,
    keep_open: bool = False,
    wait: Wait | None = None,
    label_seconds: float | None = None,
):
    """Run ``work`` in a window on the account's profile; returns what it returns.

    ``work`` gets the window and, when an earlier try of it stopped
    part-way with a project made, that project's address, to carry on in.
    The window is closed afterwards (left open with ``keep_open``, or when
    ``work`` fails, so there is something to look at). A window the person
    closes in the meantime is opened again, once. The site's security
    check, when it takes the window, is passed by the person in a plain
    window (see ``_person_passes_check``), once: a check that comes back
    after that stops the step, with the address to carry on from.
    """
    carry = ""
    reopened = False
    checked = False
    while True:
        say(
            f"A browser window just opened for {account.shown} to run the {what}. "
            f"Leave it alone; cswap closes it when the {what} is done."
        )
        window = open_window(account, root, site, executable, headless=headless, extra_args=extra_args)
        window.signed_in_as = signed_in_as
        try:
            outcome = work(window, carry)
        except (Interrupted, PageClosed) as e:
            stop = e if isinstance(e, Interrupted) else Interrupted(f"the window went away ({e})", gone=True)
            carry = stop.url or carry
            said = str(stop)
            if stop.checked:
                say(f"{said[:1].upper()}{said[1:]}. Closing that window.")
                window.close()
                if checked:
                    raise Interrupted(_checked_again(account), url=carry, checked=True) from None
                checked = True
                _person_passes_check(
                    account, root, site, executable, say=say, headless=headless, extra_args=extra_args,
                    wait=wait, label_seconds=label_seconds,
                )
                continue
            if stop.gone and not reopened:
                reopened = True
                say(f"{said[:1].upper()}{said[1:]}. Opening it again and carrying on with the {what}.")
                window.close()
                continue
            try:
                window.page.close()
            except Exception:
                pass
            raise Interrupted(f"The {what} stopped part-way: {stop}.", url=carry, checked=stop.checked, gone=stop.gone) from None
        except BaseException:
            try:
                window.page.close()
            except Exception:
                pass
            raise
        if keep_open:
            try:
                window.page.close()
            except Exception:
                pass
        else:
            window.close()
        return outcome


def move(
    source: Account,
    destination: Account,
    root: Path,
    folder: Path,
    *,
    project: str = "",
    name: str = "",
    site: str = pm.CLAUDE_URL,
    browser: str | None = None,
    login_timeout: float = 1800,
    keep_open: bool = False,
    headless: bool = False,
    extra_args: list[str] | None = None,
    wait: Wait | None = None,
    label_seconds: float | None = None,
    say: Say = _quiet,
    into: str = "",
    export: pm.ExportCheck | None = None,
) -> MoveResult:
    """Export ``project`` as ``source`` and import it as ``destination``, unattended.

    One browser window is open at a time: each account's sign-in window,
    then the source window for the export, then the destination window
    for the import. With ``into`` the import carries on in that project
    (see ``run_import``), and with ``export`` the one given is imported
    and nothing is exported: the source account is then not needed at
    all. An import that stops part-way is raised as ``Interrupted``, with
    the project it made and the export it was given, so that the next run
    can carry on.
    """
    site = site.rstrip("/")
    if profile_name(source.email or source.label) == profile_name(destination.email or destination.label):
        raise ValidationError("The source and destination are the same account.")
    executable = find_browser(browser)
    accounts = [destination] if export is not None else [source, destination]
    who = sign_everyone_in(
        accounts,
        root,
        site,
        executable,
        timeout=login_timeout,
        say=say,
        headless=headless,
        extra_args=extra_args,
        wait=wait,
        label_seconds=label_seconds,
    )
    windowed = dict(say=say, headless=headless, extra_args=extra_args, wait=wait, label_seconds=label_seconds)
    result = MoveResult()
    if export is not None:
        result.export = export
    else:
        result.export = _in_window(
            source, who[0], root, site, executable, "export",
            lambda window, carry: run_export(window, site, project, folder, say), **windowed,
        )
    try:
        result.url = _in_window(
            destination, who[-1], root, site, executable, "import",
            lambda window, carry: run_import(window, site, result.export, name, say, into=carry or into),
            keep_open=keep_open, **windowed,
        )
    except Interrupted as e:
        e.export = result.export
        raise
    return result


def login(
    accounts: list[Account],
    root: Path,
    *,
    site: str = pm.CLAUDE_URL,
    browser: str | None = None,
    login_timeout: float = 1800,
    keep_open: bool = False,
    headless: bool = False,
    extra_args: list[str] | None = None,
    wait: Wait | None = None,
    label_seconds: float | None = None,
    say: Say = _quiet,
) -> list[str]:
    """Sign each account in, once; returns who is signed in."""
    site = site.rstrip("/")
    executable = find_browser(browser)
    who = sign_everyone_in(
        accounts,
        root,
        site,
        executable,
        timeout=login_timeout,
        say=say,
        headless=headless,
        extra_args=extra_args,
        wait=wait,
        label_seconds=label_seconds,
    )
    if keep_open:
        for account in accounts:
            window = open_window(account, root, site, executable, headless=headless, extra_args=extra_args)
            try:
                window.page.close()
            except Exception:
                pass
    return who
