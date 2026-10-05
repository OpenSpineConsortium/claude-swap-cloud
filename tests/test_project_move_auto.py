"""`cswap project-move auto` and `login`: the move with no clicks.

The pieces are checked on their own first: which page shows a project, the
profile folders, the remembered settings, saving what the page sends, and
loading an export into a page. Then, where Node 20+ and a Chrome, Edge or
Chromium are installed, a real browser does whole moves against the mock
claude.ai of tests/js, served over HTTP by tests/js/mock_http_server.js.
"""

from __future__ import annotations

import base64
import glob
import http.client
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from claude_swap import cdp, cli
from claude_swap import project_move as pm
from claude_swap import project_move_auto as pma
from claude_swap.exceptions import ValidationError

JS = Path(__file__).parent / "js"
SITE = "https://claude.ai"


# ---------------------------------------------------------------------------
# Small pieces
# ---------------------------------------------------------------------------


class TestProjectPage:
    def test_an_address_is_opened_as_it_is(self):
        url = "https://claude.ai/code/project/chan_01ABCDEFGH"
        assert pma.project_page(SITE, url) == (url, "")

    def test_an_address_on_another_site_is_refused(self):
        with pytest.raises(ValidationError, match="not a page of"):
            pma.project_page(SITE, "https://example.com/project/x")

    def test_a_code_project_id_becomes_its_page(self):
        assert pma.project_page(SITE, "chan_01JbwQwHoYeBWptjPB5c6u8m") == (
            "https://claude.ai/code/project/chan_01JbwQwHoYeBWptjPB5c6u8m",
            "",
        )

    def test_a_project_uuid_becomes_its_page(self):
        uuid = "aaaaaaaa-0000-4000-8000-000000000001"
        assert pma.project_page(SITE + "/", uuid) == (f"{SITE}/project/{uuid}", "")

    def test_a_name_is_picked_from_the_list(self):
        assert pma.project_page(SITE, " beethoven ") == (f"{SITE}/projects", "beethoven")

    def test_nothing_given_lets_the_script_find_the_only_one(self):
        assert pma.project_page(SITE, "") == (f"{SITE}/projects", "")


class TestProfiles:
    def test_one_folder_per_account_named_by_email(self, tmp_path):
        a = pma.Account("source", "2", "Gregoryamdg@Gmail.com")
        b = pma.Account("destination", "1", "tulanecards@gmail.com")
        assert a.profile_dir(tmp_path) == tmp_path / pma.PROFILES_DIR / "gregoryamdg@gmail.com"
        assert b.profile_dir(tmp_path) != a.profile_dir(tmp_path)

    def test_odd_characters_are_made_safe(self):
        assert pma.profile_name("a b/c\\d:e") == "a_b_c_d_e"

    def test_same_account_on_both_sides_is_refused(self, tmp_path):
        a = pma.Account("source", "2", "x@example.com")
        b = pma.Account("destination", "x@example.com", "x@example.com")
        with pytest.raises(ValidationError, match="same account"):
            pma.move(a, b, tmp_path, tmp_path / "exports")


class TestSettings:
    def test_round_trip(self, tmp_path):
        pma.AutoSettings("2", "1", "beethoven").save(tmp_path)
        assert pma.AutoSettings.load(tmp_path) == pma.AutoSettings("2", "1", "beethoven")

    @pytest.mark.parametrize("text", ["", "not json", "[1, 2]", '{"source": 3}'])
    def test_a_bad_file_is_ignored(self, tmp_path, text):
        (tmp_path / pma.SETTINGS_FILE).write_text(text)
        assert pma.AutoSettings.load(tmp_path) == pma.AutoSettings()


class TestHelper:
    def test_helper_is_ascii(self):
        raw = (pm.resources.files("claude_swap") / pm.SCRIPT_DIR / "automation.js").read_bytes()
        raw.decode("ascii")
        assert b"\t" not in raw

    def test_helper_is_one_function_taking_its_settings(self):
        text = pma.helper_text()
        assert text.startswith("(function (config) {")
        assert text.endswith("})")


def _message(ident, path, seq, last, data):
    return {
        "name": pma.BINDING,
        "payload": json.dumps(
            {"op": "file", "id": ident, "path": path, "seq": seq, "last": last, "data": base64.b64encode(data).decode()}
        ),
    }


class TestExportWriter:
    def test_files_arrive_in_pieces(self, tmp_path):
        w = pma.ExportWriter(tmp_path)
        w.on_binding(_message(1, "proj/a/b.bin", 0, False, b"\x00\x01"))
        w.on_binding(_message(1, "proj/a/b.bin", 1, True, b"\x02"))
        w.on_binding(_message(2, "proj/export.json", 0, True, b"{}"))
        assert w.error == ""
        assert (tmp_path / "proj" / "a" / "b.bin").read_bytes() == b"\x00\x01\x02"
        assert w.files == 2 and w.bytes == 5
        assert w.exports == [tmp_path / "proj"]

    def test_an_empty_file_is_written(self, tmp_path):
        w = pma.ExportWriter(tmp_path)
        w.on_binding(_message(1, "proj/empty.txt", 0, True, b""))
        assert (tmp_path / "proj" / "empty.txt").read_bytes() == b""

    def test_an_older_export_of_the_same_name_is_left_alone(self, tmp_path):
        (tmp_path / "proj").mkdir()
        (tmp_path / "proj" / "old.txt").write_text("old")
        (tmp_path / "proj (2)").mkdir()
        w = pma.ExportWriter(tmp_path)
        w.on_binding(_message(1, "proj/new.txt", 0, True, b"new"))
        assert (tmp_path / "proj (3)" / "new.txt").read_text() == "new"
        assert not (tmp_path / "proj" / "new.txt").exists()
        assert w.exports == [tmp_path / "proj (3)"]

    @pytest.mark.parametrize("path", ["../escape.txt", "proj/../../x", "/abs", "proj/a\\b", "C:/x"])
    def test_a_path_out_of_the_folder_is_refused(self, tmp_path, path):
        w = pma.ExportWriter(tmp_path / "exports")
        w.on_binding(_message(1, path, 0, True, b"x"))
        assert "unsafe path" in w.error
        assert not (tmp_path / "escape.txt").exists()

    def test_a_piece_without_its_start_is_an_error(self, tmp_path):
        w = pma.ExportWriter(tmp_path)
        w.on_binding(_message(9, "proj/x", 1, True, b"x"))
        assert "out of order" in w.error

    def test_other_bindings_are_ignored(self, tmp_path):
        w = pma.ExportWriter(tmp_path)
        w.on_binding({"name": "somethingElse", "payload": "{"})
        assert w.error == "" and w.files == 0


class _RecordingPage:
    """Stands in for a Page: keeps what load_export sends, as the helper would."""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.calls = 0

    def evaluate(self, expression, **_):
        self.calls += 1
        batch = json.loads(re.search(r"of (\[.*\])\) window", expression).group(1))
        for path, data, append in batch:
            chunk = base64.b64decode(data)
            self.files[path] = (self.files[path] if append else b"") + chunk
        return True


class TestLoadExport:
    def test_every_file_arrives_whole(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pma, "CHUNK", 4)
        monkeypatch.setattr(pma, "LOAD_BATCH", 10)
        files = {
            "export.json": b"{}",
            "Files/empty.txt": b"",
            "Files/big.bin": bytes(range(23)),
            "Files/exact.bin": b"12345678",
            "Chats/caf\u00e9/chat.md": "h\u00e9llo".encode(),
        }
        for rel, data in files.items():
            target = tmp_path.joinpath(*rel.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        page = _RecordingPage()
        sent = pma.load_export(page, tmp_path)
        assert page.files == files
        assert sent == sum(len(v) for v in files.values())
        assert page.calls > 1  # sent in batches


class _FakeWindow:
    def __init__(self):
        self.page = type("P", (), {"close": lambda self: None})()
        self.browser = type("B", (), {"launched": True, "close": lambda self: None})()
        self.signed_in_as = ""
        self.account = None

    def close(self):
        pass


class _Exited:
    def poll(self):
        return 0


class TestSignIn:
    """The sign-in loop, with the browser stood in for."""

    def _run(self, monkeypatch, answers, email="a@example.com", **kwargs):
        opened = []
        plain = []
        said = []

        def open_window(account, root, site, executable, **_):
            w = _FakeWindow()
            w.account = account
            opened.append(w)
            return w

        monkeypatch.setattr(pma, "open_window", open_window)
        monkeypatch.setattr(pma, "who_is_signed_in", lambda page, site: answers.pop(0))
        monkeypatch.setattr(pma, "launch_plain", lambda exe, profile, url, **kw: plain.append((profile, url, kw)) or _Exited())
        monkeypatch.setattr(pma.time, "sleep", lambda s: None)
        account = pma.Account("source", "2", email)
        window = pma.sign_in(account, Path("/root"), "https://claude.ai", "chrome", say=said.append, **kwargs)
        return window, opened, plain, said

    def test_a_profile_already_signed_in_asks_nothing(self, monkeypatch):
        window, opened, plain, said = self._run(monkeypatch, [(True, "a@example.com")])
        assert window.signed_in_as == "a@example.com"
        assert len(opened) == 1 and plain == [] and said == []

    def test_an_email_the_site_does_not_give_is_taken_on_trust(self, monkeypatch):
        window, opened, plain, said = self._run(monkeypatch, [(True, "")])
        assert window.signed_in_as == "a@example.com"
        assert plain == []

    def test_the_first_time_opens_a_plain_window_at_the_login_page(self, monkeypatch):
        window, opened, plain, said = self._run(monkeypatch, [(False, ""), (True, "a@example.com")])
        assert window is opened[1]
        assert len(plain) == 1
        profile, url, kw = plain[0]
        assert profile == Path("/root") / pma.PROFILES_DIR / "a@example.com"
        assert url == "https://claude.ai/login"
        assert "a@example.com" in said[0] and "SOURCE" in said[0] and "close that window" in said[0]
        assert said[1].startswith("Checking the sign-in")

    def test_the_wrong_account_is_sent_to_sign_out_first(self, monkeypatch):
        window, opened, plain, said = self._run(
            monkeypatch, [(True, "b@example.com"), (True, "a@example.com")]
        )
        assert len(plain) == 1
        assert "signed in to claude.ai as b@example.com, not a@example.com" in said[0]
        assert "Sign out there" in said[0]
        assert window.signed_in_as == "a@example.com"

    def test_it_keeps_asking_until_the_time_is_up(self, monkeypatch):
        clock = iter([0, 0, 0, 100, 100, 100, 100, 100])
        monkeypatch.setattr(pma.time, "monotonic", lambda: next(clock, 100))
        with pytest.raises(cdp.BrowserError, match="in time"):
            self._run(monkeypatch, [(False, ""), (False, ""), (False, "")], timeout=50)

    def test_a_window_the_person_does_not_close_is_an_error(self, monkeypatch):
        class Open:
            def poll(self):
                return None

        monkeypatch.setattr(pma, "open_window", lambda *a, **k: _FakeWindow())
        monkeypatch.setattr(pma, "who_is_signed_in", lambda page, site: (False, ""))
        monkeypatch.setattr(pma, "launch_plain", lambda *a, **k: Open())
        monkeypatch.setattr(pma.time, "sleep", lambda s: None)
        clock = iter([0, 0, 100])
        monkeypatch.setattr(pma.time, "monotonic", lambda: next(clock, 100))
        with pytest.raises(cdp.BrowserError, match="was not closed in time"):
            pma.sign_in(pma.Account("source", "2", "a@example.com"), Path("/r"), "https://claude.ai", "chrome", timeout=50)


# ---------------------------------------------------------------------------
# The command
# ---------------------------------------------------------------------------


def _run(argv, capsys):
    with patch("os.geteuid", return_value=1000, create=True), \
         patch.object(sys, "argv", ["cswap", "project-move", *argv]):
        code = 0
        try:
            cli.main()
        except SystemExit as e:
            code = e.code or 0
    captured = capsys.readouterr()
    return code, captured.out, captured.err


class TestCommand:
    def test_accounts_are_needed_the_first_time(self, temp_home, capsys):
        code, out, err = _run(["auto"], capsys)
        assert code == 1
        assert "--from 2 --to 1" in out + err

    def test_an_unknown_slot_is_an_error(self, temp_home, capsys):
        code, out, err = _run(["auto", "--from", "7", "--to", "8"], capsys)
        assert code == 1

    def test_a_move_is_remembered_for_next_time(self, temp_home, capsys, tmp_path):
        export = pm.ExportCheck(path=tmp_path / "beethoven", name="beethoven", kind="code")
        result = pma.MoveResult(export=export, url="https://claude.ai/code/project/chan_NEW")
        with patch.object(pma, "move", return_value=result) as moved:
            code, out, _ = _run(
                ["auto", "beethoven", "--from", "a@example.com", "--to", "b@example.com"], capsys
            )
        assert code == 0, out
        assert "https://claude.ai/code/project/chan_NEW" in out
        (source, destination, _root, folder), kwargs = moved.call_args
        assert (source.role, source.email) == ("source", "a@example.com")
        assert (destination.role, destination.email) == ("destination", "b@example.com")
        assert kwargs["project"] == "beethoven"
        assert folder == pm.default_exports_folder()

        # The next run needs nothing but the command.
        with patch.object(pma, "move", return_value=result) as moved:
            code, out, _ = _run(["auto"], capsys)
        assert code == 0, out
        (source, destination, _root, _folder), kwargs = moved.call_args
        assert (source.email, destination.email, kwargs["project"]) == ("a@example.com", "b@example.com", "beethoven")

        # And the step list of `project-move` shows the move as done.
        code, out, _ = _run([], capsys)
        assert "All steps are done" in out

    def test_login_remembers_the_accounts(self, temp_home, capsys):
        with patch.object(pma, "login", return_value=["a@example.com", "b@example.com"]):
            code, out, _ = _run(["login", "--from", "a@example.com", "--to", "b@example.com"], capsys)
        assert code == 0, out
        assert "Signed in" in out
        with patch.object(pma, "move", return_value=pma.MoveResult()) as moved:
            _run(["auto", "x"], capsys)
        source, destination = moved.call_args.args[:2]
        assert (source.email, destination.email) == ("a@example.com", "b@example.com")

    def test_a_browser_problem_is_reported_not_raised(self, temp_home, capsys):
        with patch.object(pma, "move", side_effect=cdp.BrowserError("Chrome or Edge was not found.")):
            code, out, err = _run(["auto", "--from", "a@example.com", "--to", "b@example.com"], capsys)
        assert code == 1
        assert "Chrome or Edge was not found" in out + err


# ---------------------------------------------------------------------------
# A real browser against the mock claude.ai
# ---------------------------------------------------------------------------


def _node() -> str | None:
    exe = shutil.which("node")
    if not exe:
        return None
    try:
        major = int(subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=60).stdout.strip().lstrip("v").split(".")[0])
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return exe if major >= 20 else None


def _browser() -> str | None:
    try:
        return cdp.find_browser()
    except cdp.BrowserError:
        pass
    found = sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"))
    return found[-1] if found else None


NODE = _node()
BROWSER = _browser() if NODE else None
real_browser = pytest.mark.skipif(
    NODE is None or BROWSER is None, reason="needs Node 20+ and Chrome, Edge or Chromium"
)
# Headless, and without the sandbox that root (CI containers) cannot use.
BROWSER_ARGS = ["--no-sandbox", "--disable-gpu"]


class _Mock:
    """tests/js/mock_http_server.js, running."""

    def __init__(self, *args: str):
        self.proc = subprocess.Popen(
            [NODE, str(JS / "mock_http_server.js"), *args], stdout=subprocess.PIPE, text=True
        )
        line = self.proc.stdout.readline()
        self.port = int(line.split()[1])
        self.site = f"http://127.0.0.1:{self.port}"

    def made(self) -> dict:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/__mock/made")
        return json.loads(conn.getresponse().read())

    def stop(self) -> None:
        self.proc.kill()
        self.proc.wait(10)


@pytest.fixture
def mocks():
    started: list[_Mock] = []

    def start(*args: str) -> _Mock:
        started.append(_Mock(*args))
        return started[-1]

    yield start
    for m in started:
        m.stop()


def _window(account, root, site, said=None, wait=None):
    return pma.sign_in(
        account, root, site, BROWSER, timeout=60, say=(said.append if said is not None else pma._quiet),
        headless=True, extra_args=BROWSER_ARGS, wait=wait,
    )


def _settled(name: str, data: bytes) -> bytes:
    """A file of an export with the one thing that differs between runs taken out."""
    if name.endswith("/export.json"):
        return json.dumps({**json.loads(data), "exported_at": ""}).encode()
    return data


@real_browser
@pytest.mark.xdist_group("real-browser")
def test_a_real_browser_exports_and_imports_unattended(mocks, tmp_path):
    source_site = mocks("--small")
    dest_site = mocks()
    root = tmp_path / "cswap"
    said: list[str] = []

    src = _window(pma.Account("source", "2"), root, source_site.site, said)
    dst = _window(pma.Account("destination", "1"), root, dest_site.site, said)
    try:
        assert said == []  # the mock is signed in from the start: nothing to ask

        export = pma.run_export(
            src, source_site.site, "chan_01BEETHOVENBEETHOVEN0000", tmp_path / "exports", said.append
        )
        assert export.complete and export.kind == "code"
        assert export.path == tmp_path / "exports" / "beethoven"

        # What the browser saved is what the script saves under Node, byte for byte.
        reference = tmp_path / "reference"
        node = subprocess.run(
            [NODE, str(JS / "export_to_disk.js"), str(reference)], capture_output=True, text=True, timeout=600
        )
        assert node.returncode == 0, node.stderr
        got = {p.relative_to(tmp_path / "exports").as_posix(): p.read_bytes() for p in export.path.rglob("*") if p.is_file()}
        want = {
            p.relative_to(reference).as_posix(): p.read_bytes()
            for p in (reference / "beethoven").rglob("*")
            if p.is_file()
        }
        assert sorted(got) == sorted(want)
        for name in want:
            assert _settled(name, got[name]) == _settled(name, want[name]), name

        url = pma.run_import(dst, dest_site.site, export, "", said.append)
    finally:
        src.close()
        dst.close()

    made = dest_site.made()
    assert [c["name"] for c in made["channels"]] == ["beethoven (imported)"]
    assert url == f"{dest_site.site}/code/project/{made['channels'][0]['id']}"
    assert any(f.startswith("imported-history/") for f in made["channels"][0]["files"])
    assert any(line.strip().startswith("Done") for line in said)


@real_browser
@pytest.mark.xdist_group("real-browser")
def test_the_first_run_signs_in_through_a_plain_window(mocks, tmp_path):
    site = mocks("--signed-out")
    root = tmp_path / "cswap"
    said: list[str] = []
    account = pma.Account("source", "2", "src@example.com")
    profile = account.profile_dir(root)

    # The mock's sign-in page signs the browser in and then closes its own
    # window, which is what the person does. This only looks on, to see that
    # the window it happened in had no DevTools port.
    closed: list[int] = []

    def looking_on(process):
        deadline = time.monotonic() + 60
        while site.made()["logins"] < 1:
            assert time.monotonic() < deadline, "the sign-in page was never shown"
            assert process.poll() is None, "the sign-in window closed before the page was shown"
            time.sleep(0.2)
        assert not (profile / cdp.PORT_FILE).exists()  # no DevTools port on this one
        closed.append(process.wait(60))

    window = _window(account, root, site.site, said, wait=looking_on)
    try:
        assert window.signed_in_as == "src@example.com"
        assert closed == [0]
        assert site.made()["logins"] == 1
        assert any("Sign in to claude.ai there" in line and "src@example.com" in line and "SOURCE" in line for line in said)
        assert any(line.startswith("Checking the sign-in") for line in said)
        # The driven window is on the port again, and the site is signed in.
        assert (profile / cdp.PORT_FILE).exists()
        assert window.page.evaluate("fetch('/api/organizations').then(r => r.status)") == 200
    finally:
        window.close()

    # The next time, nothing is asked.
    said.clear()
    window = _window(account, root, site.site, said)
    try:
        assert said == []
        assert window.signed_in_as == "src@example.com"
    finally:
        window.close()
    assert site.made()["logins"] == 1


@real_browser
@pytest.mark.xdist_group("real-browser")
def test_the_command_moves_a_project_and_a_second_run_needs_no_options(mocks, temp_home, capsys):
    site = mocks()
    argv = [
        "auto",
        "beethoven",
        "--from",
        "source@example.com",
        "--to",
        "dest@example.com",
        "--name",
        "Moved by cswap",
        "--site",
        site.site,
        "--headless",
        "--browser",
        BROWSER,
        *[f"--browser-arg={a}" for a in BROWSER_ARGS],
        "--login-timeout",
        "60",
    ]
    code, out, err = _run(argv, capsys)
    assert code == 0, out + err
    assert "Moved: the new project is at " + site.site in out
    assert [c["name"] for c in site.made()["channels"]] == ["Moved by cswap"]

    code, out, err = _run(
        ["auto", "--name", "Moved again", "--site", site.site, "--headless", "--browser", BROWSER,
         *[f"--browser-arg={a}" for a in BROWSER_ARGS]],
        capsys,
    )
    assert code == 0, out + err
    assert sorted(c["name"] for c in site.made()["channels"]) == ["Moved again", "Moved by cswap"]
    # The second export did not land in the first one's folder.
    assert (pm.default_exports_folder() / "beethoven (2)" / pm.MANIFEST_NAME).is_file()


@real_browser
@pytest.mark.xdist_group("real-browser")
def test_a_name_that_matches_no_project_lists_the_projects(mocks, temp_home, capsys):
    site = mocks()
    code, out, err = _run(
        ["auto", "no such project", "--from", "s@example.com", "--to", "d@example.com", "--site", site.site,
         "--headless", "--browser", BROWSER, *[f"--browser-arg={a}" for a in BROWSER_ARGS]],
        capsys,
    )
    assert code == 1
    text = out + err
    assert 'No single project here is called "no such project"' in text
    assert "beethoven" in text
    assert site.made()["channels"] == []
