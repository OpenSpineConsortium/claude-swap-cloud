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
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Callable

from claude_swap import project_move as pm
from claude_swap.cdp import Browser, BrowserError, EvaluationError, Page, PageClosed, find_browser
from claude_swap.exceptions import ValidationError

PROFILES_DIR = "browser-profiles"
SETTINGS_FILE = "project-move-auto.json"
BINDING = "cswapPut"
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

    @classmethod
    def load(cls, root: Path) -> "AutoSettings":
        try:
            raw = json.loads((root / SETTINGS_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cls()
        if not isinstance(raw, dict):
            return cls()
        return cls(**{k: raw[k] for k in ("source", "destination", "project") if isinstance(raw.get(k), str)})

    def save(self, root: Path) -> None:
        root.mkdir(parents=True, exist_ok=True)
        path = root / SETTINGS_FILE
        tmp = path.with_suffix(".json.tmp")
        payload = {"source": self.source, "destination": self.destination, "project": self.project}
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


# ---------------------------------------------------------------------------
# Signing in, once per account
# ---------------------------------------------------------------------------

_SIGNED_IN = """(async () => {
  if (location.origin !== %(origin)s) return {page: location.href};
  let orgs = 0;
  try {
    const r = await fetch('/api/organizations', {credentials: 'include', headers: {Accept: 'application/json'}});
    if (!r.ok) return {page: location.href, status: r.status};
    const v = await r.json();
    orgs = Array.isArray(v) ? v.length : 0;
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
  return {page: location.href, signedIn: orgs > 0, email};
})()"""

# A strip across the top of the window that says which account belongs in it.
_BANNER = """(() => {
  if (location.origin !== %(origin)s) return false;
  let el = document.getElementById('cswap-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cswap-banner';
    Object.assign(el.style, {position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647',
      padding: '8px 12px', font: '600 14px system-ui, sans-serif', color: '#fff', textAlign: 'center',
      pointerEvents: 'none'});
    document.documentElement.appendChild(el);
  }
  el.style.background = %(color)s;
  el.textContent = %(text)s;
  return true;
})()"""

_CLEAR_BANNER = "(() => { const el = document.getElementById('cswap-banner'); if (el) el.remove(); return true; })()"


@dataclass
class Window:
    """One account's browser window, and the tab cswap works in."""

    account: Account
    browser: Browser
    page: Page
    signed_in_as: str = ""
    told: str = ""  # the last thing said about this window, so it is said once
    ok: bool = False
    extra: dict = field(default_factory=dict)

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
    """Start (or join) this account's browser and take a tab on ``site``."""
    profile = account.profile_dir(root)
    browser = Browser.start(executable, profile, site + "/", headless=headless, extra_args=extra_args)
    tab = browser.tab(prefer=site)
    page = browser.connect(tab)
    if not str(tab.get("url", "")).startswith(site):
        page.navigate(site + "/")
    return Window(account=account, browser=browser, page=page)


def _js(value: str) -> str:
    return json.dumps(value)


def check_signed_in(window: Window, site: str) -> bool:
    """Whether the window is signed in to ``site`` as its account; says what to do if not."""
    origin = _js(site.rstrip("/"))
    try:
        info = window.page.evaluate(_SIGNED_IN % {"origin": origin}, timeout=30)
    except EvaluationError:
        info = None
    except BrowserError as e:
        if isinstance(e, PageClosed):
            raise BrowserError(
                f"The {window.account.role.upper()} window ({window.account.shown}) was closed. Run this again."
            ) from None
        info = None  # between pages
    if not isinstance(info, dict):
        return False
    email = str(info.get("email") or "")
    want = window.account.email
    if info.get("signedIn"):
        if want and email and email.lower() != want.lower():
            text = (
                f"cswap: this window is signed in as {email}. Sign out (bottom left, then Log out) "
                f"and sign in as {want}."
            )
            _banner(window, origin, text, "#b3261e")
            window.extra["mismatch"] = email
            return False
        window.signed_in_as = email or want
        window.extra.pop("mismatch", None)
        window.page.evaluate(_CLEAR_BANNER, await_promise=False, timeout=10)
        return True
    role = "SOURCE" if window.account.role == "source" else "DESTINATION"
    _banner(window, origin, f"cswap: sign in here as {window.account.shown} ({role} account)", "#1f6feb")
    return False


def _banner(window: Window, origin: str, text: str, color: str) -> None:
    try:
        window.page.evaluate(
            _BANNER % {"origin": origin, "text": _js(text), "color": _js(color)}, await_promise=False, timeout=10
        )
    except BrowserError:
        pass


def wait_signed_in(windows: list[Window], site: str, timeout: float, say: Say = _quiet, poll: float = 2.0) -> None:
    """Wait until every window is signed in as its account (the one-time login)."""
    deadline = time.monotonic() + timeout
    while True:
        waiting = []
        for window in windows:
            if window.ok:
                continue
            window.ok = check_signed_in(window, site)
            if window.ok:
                if window.told:
                    say(f"Signed in as {window.signed_in_as} in the {window.account.role} window.")
                continue
            waiting.append(window)
            role = window.account.role.upper()
            if window.extra.get("mismatch"):
                news = (
                    f"The {role} window is signed in as {window.extra['mismatch']}; "
                    f"sign out there and sign in as {window.account.shown}."
                )
            else:
                news = f"Sign in to claude.ai as {window.account.shown} in the window with the blue {role} strip."
            if news != window.told:
                say(news)
                window.told = news
        if not waiting:
            return
        if time.monotonic() >= deadline:
            names = ", ".join(w.account.shown for w in waiting)
            raise BrowserError(f"Nobody signed in as {names} in time. Run this again to keep waiting.")
        for window in waiting:
            window.page.pump(poll / max(1, len(waiting)))


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


def _follow(page: Page, say: Say, *, timeout: float, fail_words: tuple[str, ...]) -> dict:
    """Press the script's button, then report its status lines until it ends."""
    state = page_state(page)
    if not state.get("ready"):
        errors = "; ".join(state.get("errors") or []) or "its button did not appear"
        raise BrowserError(f"The script did not get ready: {errors}")
    page.evaluate("window.__cswap.press()", await_promise=False)
    last = ""
    deadline = time.monotonic() + timeout
    while True:
        page.pump(0.5)
        state = page_state(page)
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
            raise BrowserError("The script did not finish in time. Its window is left open.")


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
    code_names: list[str] = []
    if name:
        found, code_names = find_code_project(page, name)
        if found:
            url, name = project_page(site, found)
    say(f"Opening {url} in the source window.")
    page.navigate(url)
    page.wait_loaded(site)
    _settle(page, 4.0)

    folder.mkdir(parents=True, exist_ok=True)
    writer = ExportWriter(folder)
    page.handlers["Runtime.bindingCalled"] = writer.on_binding
    page.call("Runtime.enable")
    page.call("Runtime.addBinding", {"name": BINDING})
    try:
        install_helper(page, "export", project=name)
        _run_script(page, "export")
        state = _follow(page, say, timeout=timeout, fail_words=("Export failed",))
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


def run_import(window: Window, site: str, export: pm.ExportCheck, name: str = "", say: Say = _quiet, timeout: float = 4 * 3600) -> str:
    """Import ``export`` in the destination window; returns the new project's address."""
    page = window.page
    page.navigate(site.rstrip("/") + "/")
    page.wait_loaded(site)
    _settle(page, 2.0)
    install_helper(page, "import", name=name)
    sent = load_export(page, export.path)
    say(f"Loaded the export into the destination window ({pm.size_text(sent)}).")
    _run_script(page, "import")
    state = _follow(
        page,
        say,
        timeout=timeout,
        fail_words=("Import failed", "The import stopped part-way", "Nothing was imported"),
    )
    if state.get("sourceVisible"):
        say(
            "Note: the destination account can see the project this came from. If both windows "
            "were meant to be different accounts, check which account the destination window uses."
        )
    if not state.get("done"):
        status = state.get("status") or "The import did not finish."
        raise BrowserError(status)
    return state.get("link") or ""


# ---------------------------------------------------------------------------
# The whole move
# ---------------------------------------------------------------------------


@dataclass
class MoveResult:
    export: pm.ExportCheck | None = None
    url: str = ""


def open_windows(
    accounts: list[Account],
    root: Path,
    site: str,
    browser: str | None = None,
    *,
    headless: bool = False,
    extra_args: list[str] | None = None,
) -> list[Window]:
    executable = find_browser(browser)
    windows: list[Window] = []
    try:
        for account in accounts:
            windows.append(open_window(account, root, site, executable, headless=headless, extra_args=extra_args))
    except BaseException:
        for window in windows:
            window.close()
        raise
    return windows


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
    say: Say = _quiet,
) -> MoveResult:
    """Export ``project`` as ``source`` and import it as ``destination``, unattended."""
    site = site.rstrip("/")
    if profile_name(source.email or source.label) == profile_name(destination.email or destination.label):
        raise ValidationError("The source and destination are the same account.")
    windows = open_windows([source, destination], root, site, browser, headless=headless, extra_args=extra_args)
    result = MoveResult()
    finished = False
    try:
        wait_signed_in(windows, site, login_timeout, say)
        result.export = run_export(windows[0], site, project, folder, say)
        result.url = run_import(windows[1], site, result.export, name, say)
        finished = True
        return result
    finally:
        # A finished move closes its windows; a failed one leaves them open to look at.
        for window in windows:
            if finished and not keep_open:
                window.close()
            else:
                try:
                    window.page.close()
                except Exception:
                    pass


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
    say: Say = _quiet,
) -> list[str]:
    """Open each account's window and wait until it is signed in; returns who is signed in."""
    site = site.rstrip("/")
    windows = open_windows(accounts, root, site, browser, headless=headless, extra_args=extra_args)
    try:
        wait_signed_in(windows, site, login_timeout, say)
        return [w.signed_in_as or w.account.shown for w in windows]
    finally:
        for window in windows:
            if keep_open:
                window.page.close()
            else:
                window.close()
