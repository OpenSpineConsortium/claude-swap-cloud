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
import os
import re
import shutil
import sqlite3
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
MOCK_ORG = "dddddddd-0000-4000-8000-000000000001"  # the mock site's chat organization


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
        pma.AutoSettings("2", "1", "beethoven", "https://claude.ai/code/project/chan_01X").save(tmp_path)
        assert pma.AutoSettings.load(tmp_path).into == "https://claude.ai/code/project/chan_01X"

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

    def _run(self, monkeypatch, tmp_path, answers, email="a@example.com", org="", **kwargs):
        opened = []
        plain = []
        said = []

        def open_window(account, root, site, executable, **_):
            w = _FakeWindow()
            w.account = account
            opened.append(w)
            return w

        monkeypatch.setattr(pma, "open_window", open_window)
        def who(page, site, **_):
            answer = answers.pop(0)
            if isinstance(answer, BaseException):
                raise answer
            return answer

        monkeypatch.setattr(pma, "who_is_signed_in", who)
        # What the plain window was opened on, and whether its profile folder
        # still existed then (a signed-out profile is gone by that point).
        monkeypatch.setattr(
            pma, "launch_plain", lambda exe, profile, url, **kw: plain.append((profile, url, kw, profile.exists())) or _Exited()
        )
        monkeypatch.setattr(pma.time, "sleep", lambda s: None)
        account = pma.Account("source", "2", email, org)
        window = pma.sign_in(account, tmp_path, "https://claude.ai", "chrome", say=said.append, **kwargs)
        return window, opened, plain, said

    def test_a_profile_already_signed_in_asks_nothing(self, monkeypatch, tmp_path):
        window, opened, plain, said = self._run(monkeypatch, tmp_path, [pma.SignedIn(True, "A@Example.com")])
        assert window.signed_in_as == "A@Example.com"
        assert len(opened) == 1 and plain == [] and said == []

    def test_an_account_the_site_lists_by_its_organization_is_known(self, monkeypatch, tmp_path):
        window, opened, plain, said = self._run(
            monkeypatch, tmp_path, [pma.SignedIn(True, "", ("org-1", "org-2"))], org="ORG-2"
        )
        assert window.signed_in_as == "a@example.com"
        assert plain == [] and said == []

    def test_the_first_time_opens_a_plain_window_at_the_login_page(self, monkeypatch, tmp_path):
        window, opened, plain, said = self._run(
            monkeypatch, tmp_path, [pma.SignedIn(False), pma.SignedIn(True, "a@example.com")]
        )
        assert window is opened[1]
        assert len(plain) == 1
        profile, url, kw, _ = plain[0]
        assert profile == tmp_path / pma.PROFILES_DIR / "a@example.com"
        # The window opens on the page that names the account, with the
        # button to the sign-in page.
        label = tmp_path / pma.PROFILES_DIR / ("a@example.com" + pma.LABEL_SUFFIX)
        assert url == label.resolve().as_uri()
        assert 'href="https://claude.ai/login"' in label.read_text()
        assert said[0] == (
            "A browser window just opened for a@example.com (the SOURCE account); it says so in blue. "
            "Use its button to sign in to claude.ai as a@example.com. A few seconds after you are "
            "signed in, the window closes by itself (closing it yourself is fine too)."
        )
        assert said[1].startswith("Checking the sign-in")
        assert said[2] == "Signed in as a@example.com (source)."

    def test_the_wrong_account_is_signed_out_before_the_window_opens(self, monkeypatch, tmp_path):
        profile = tmp_path / pma.PROFILES_DIR / "a@example.com"
        (profile / "Default").mkdir(parents=True)
        (profile / "Default" / "Cookies").write_bytes(b"b's session")
        window, opened, plain, said = self._run(
            monkeypatch, tmp_path, [pma.SignedIn(True, "b@example.com"), pma.SignedIn(True, "a@example.com")]
        )
        assert said[0] == "The a@example.com window was signed in as b@example.com. Signed it out."
        assert len(plain) == 1
        assert plain[0][3] is False  # the profile, b's session with it, was gone before the window opened
        assert "sign in to claude.ai as a@example.com" in said[1]
        assert window.signed_in_as == "a@example.com"

    def test_a_sign_in_the_site_will_not_name_is_signed_out_and_asked_for(self, monkeypatch, tmp_path):
        # A profile from before cswap took note of its sign-ins: nobody can
        # say whose it is, so it is not taken on trust.
        window, opened, plain, said = self._run(monkeypatch, tmp_path, [pma.SignedIn(True), pma.SignedIn(True)])
        assert said[0] == "The a@example.com window was signed in, but claude.ai did not say as whom. Signed it out."
        assert len(plain) == 1
        assert window.signed_in_as == "a@example.com"
        assert said[-1].startswith("Signed in for a@example.com (source). claude.ai did not say as whom")
        # The sign-in the person just made is noted, so the next run is silent.
        note = json.loads((tmp_path / pma.PROFILES_DIR / "a@example.com" / pma.SIGN_IN_FILE).read_text())
        assert note["account"] == "a@example.com" and note["verified"] is False

    def test_a_sign_in_the_person_made_here_is_trusted_when_the_site_does_not_say(self, monkeypatch, tmp_path):
        profile = tmp_path / pma.PROFILES_DIR / "a@example.com"
        profile.mkdir(parents=True)
        (profile / pma.SIGN_IN_FILE).write_text(json.dumps({"account": "a@example.com", "verified": False}))
        window, opened, plain, said = self._run(monkeypatch, tmp_path, [pma.SignedIn(True)])
        assert window.signed_in_as == "a@example.com"
        assert plain == [] and said == []

    def test_a_sign_in_made_for_another_account_is_not_trusted(self, monkeypatch, tmp_path):
        profile = tmp_path / pma.PROFILES_DIR / "a@example.com"
        profile.mkdir(parents=True)
        (profile / pma.SIGN_IN_FILE).write_text(json.dumps({"account": "b@example.com", "verified": False}))
        window, opened, plain, said = self._run(monkeypatch, tmp_path, [pma.SignedIn(True), pma.SignedIn(True)])
        assert len(plain) == 1 and said[0].endswith("Signed it out.")

    def test_signing_in_as_the_wrong_account_is_refused(self, monkeypatch, tmp_path):
        profile = tmp_path / pma.PROFILES_DIR / "a@example.com"
        profile.mkdir(parents=True)
        with pytest.raises(ValidationError) as caught:
            self._run(monkeypatch, tmp_path, [pma.SignedIn(False), pma.SignedIn(True, "b@example.com")])
        assert str(caught.value) == (
            "You signed in as b@example.com, but that window was for a@example.com (the SOURCE account). "
            "It is signed out again. Run this again and sign in there as a@example.com."
        )
        assert not profile.exists()

    def test_signing_in_to_another_organization_is_refused(self, monkeypatch, tmp_path):
        with pytest.raises(ValidationError, match="You signed in as another account, but that window was for"):
            self._run(monkeypatch, tmp_path, [pma.SignedIn(False), pma.SignedIn(True, "", ("org-2",))], org="org-1")

    def test_it_keeps_asking_until_the_time_is_up(self, monkeypatch, tmp_path):
        clock = iter([0, 0, 0, 100, 100, 100, 100, 100])
        monkeypatch.setattr(pma.time, "monotonic", lambda: next(clock, 100))
        with pytest.raises(cdp.BrowserError, match="in time"):
            self._run(monkeypatch, tmp_path, [pma.SignedIn(False), pma.SignedIn(False), pma.SignedIn(False)], timeout=50)

    def test_the_sites_check_is_passed_in_a_plain_window_and_the_driven_one_opened_again(self, monkeypatch, tmp_path):
        answers = [pma.Interrupted("the check", checked=True), pma.SignedIn(True, "a@example.com")]
        window, opened, plain, said = self._run(monkeypatch, tmp_path, answers)
        assert window is opened[1] and len(opened) == 2
        assert len(plain) == 1 and plain[0][1].endswith("a%40example.com" + pma.CHECK_SUFFIX)
        assert said[0].startswith("That check does not pass in a driven window. A normal browser window just opened for a@example.com (the SOURCE account) instead")
        assert said[1] == "Opening the a@example.com window again."

    def test_a_check_that_comes_straight_back_stops_the_run(self, monkeypatch, tmp_path):
        answers = [pma.Interrupted("the check", checked=True), pma.Interrupted("the check", checked=True)]
        with pytest.raises(pma.Interrupted, match="asked for its security check again in the a@example.com window right after it passed"):
            self._run(monkeypatch, tmp_path, answers)

    def test_a_window_the_person_does_not_close_is_an_error(self, monkeypatch, tmp_path):
        class Open:
            def poll(self):
                return None

        monkeypatch.setattr(pma, "open_window", lambda *a, **k: _FakeWindow())
        monkeypatch.setattr(pma, "who_is_signed_in", lambda page, site, **_: pma.SignedIn(False))
        monkeypatch.setattr(pma, "launch_plain", lambda *a, **k: Open())
        monkeypatch.setattr(pma.time, "sleep", lambda s: None)
        clock = iter([0, 0, 100])
        monkeypatch.setattr(pma.time, "monotonic", lambda: next(clock, 100))
        with pytest.raises(cdp.BrowserError, match="Nobody signed in there in time"):
            pma.sign_in(pma.Account("source", "2", "a@example.com"), tmp_path, "https://claude.ai", "chrome", timeout=50)


class TestOpenWindow:
    def test_the_browser_starts_blank_and_the_one_navigation_is_ours(self, tmp_path, monkeypatch):
        # A start address on the command line can land after Page.navigate
        # and cut it off, so the browser is started on about:blank.
        started, navigated = [], []

        class FakePage:
            def location(self):
                return "about:blank", "complete"

            def navigate(self, url):
                navigated.append(url)

        class FakeBrowser:
            launched = True

            @classmethod
            def start(cls, executable, profile, url, **kwargs):
                started.append(url)
                return cls()

            def own_tab(self):
                return {"url": "about:blank"}

            def connect(self, tab):
                return FakePage()

        monkeypatch.setattr(pma, "Browser", FakeBrowser)
        pma.open_window(pma.Account("source", "2", "a@example.com"), tmp_path, "http://127.0.0.1:8", "chrome")
        assert started == ["about:blank"]
        assert navigated == ["http://127.0.0.1:8/"]

    def test_a_browser_it_started_works_in_a_blank_tab_of_its_own(self, tmp_path, monkeypatch):
        # Chrome 154 brings the tabs the profile's last window had back on
        # the next start, unloaded, so a browser started here does not take
        # the tab that seems to be on the site already: that is for a
        # browser found running, which is joined where it is.
        asked = []

        class FakePage:
            def location(self):
                return "http://127.0.0.1:8/", "complete"

            def navigate(self, url):
                asked.append(("navigate", url))

        class FakeBrowser:
            launched = True

            @classmethod
            def start(cls, executable, profile, url, **kwargs):
                return cls()

            def own_tab(self):
                asked.append(("own_tab",))
                return {"url": "about:blank"}

            def tab(self, prefer=""):
                asked.append(("tab", prefer))
                return {"url": "http://127.0.0.1:8/"}

            def connect(self, tab):
                return FakePage()

        monkeypatch.setattr(pma, "Browser", FakeBrowser)
        pma.open_window(pma.Account("source", "2", "a@example.com"), tmp_path, "http://127.0.0.1:8", "chrome")
        assert asked == [("own_tab",), ("navigate", "http://127.0.0.1:8/")]

        asked.clear()
        FakeBrowser.launched = False
        pma.open_window(pma.Account("source", "2", "a@example.com"), tmp_path, "http://127.0.0.1:8", "chrome")
        assert asked == [("tab", "http://127.0.0.1:8")]


class TestLabelPage:
    def test_it_names_the_account_and_leads_to_the_sign_in_page(self, tmp_path):
        url = pma.label_page(pma.Account("destination", "1", "b@example.com"), "https://claude.ai/", tmp_path)
        path = tmp_path / pma.PROFILES_DIR / ("b@example.com" + pma.LABEL_SUFFIX)
        assert url == path.resolve().as_uri()
        text = path.read_text(encoding="ascii")
        assert "<title>Sign in as b@example.com (DESTINATION)</title>" in text
        assert "this window is for the DESTINATION account<b>b@example.com</b>" in text
        assert '<a class="go" href="https://claude.ai/login">Sign in to claude.ai as b@example.com</a>' in text
        assert "You can leave this window open: a few seconds after you are signed in," in text
        assert "http-equiv" not in text  # it waits for the button

    def test_it_can_go_on_by_itself_for_the_tests(self, tmp_path):
        url = pma.label_page(pma.Account("source", "2", "a@example.com"), "http://127.0.0.1:8", tmp_path, 1.5)
        path = tmp_path / pma.PROFILES_DIR / ("a@example.com" + pma.LABEL_SUFFIX)
        assert url == path.resolve().as_uri()
        text = path.read_text(encoding="ascii")
        assert '<meta http-equiv="refresh" content="1.5;url=http://127.0.0.1:8/login">' in text

    def test_the_check_page_leads_to_the_site_itself(self, tmp_path):
        url = pma.label_page(pma.Account("destination", "1", "b@example.com"), "https://claude.ai", tmp_path, 2, check=True)
        path = tmp_path / pma.PROFILES_DIR / ("b@example.com" + pma.CHECK_SUFFIX)
        assert url == path.resolve().as_uri()
        text = path.read_text(encoding="ascii")
        assert "<title>Pass claude.ai's check as b@example.com (DESTINATION)</title>" in text
        assert "this window is for the DESTINATION account<b>b@example.com</b>" in text
        assert '<a class="go" href="https://claude.ai/">Open claude.ai as b@example.com</a>' in text
        assert "if the check shows a box to tick, tick it" in text
        assert '<meta http-equiv="refresh" content="2;url=https://claude.ai/">' in text

    def test_markup_in_a_name_is_shown_not_run(self, tmp_path):
        pma.label_page(pma.Account("source", "<b>x</b>&y@example.com"), "https://claude.ai", tmp_path)
        text = next((tmp_path / pma.PROFILES_DIR).glob("*" + pma.LABEL_SUFFIX)).read_text()
        assert "<b>x</b>&y" not in text and "&lt;b&gt;x&lt;/b&gt;&amp;y@example.com" in text


def _cookie_db(profile: Path, rel: str = "Default/Network/Cookies") -> Path:
    """A cookie store laid out as Chrome's, with no rows yet."""
    import sqlite3

    path = profile / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE cookies (creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, name TEXT NOT NULL, "
        "value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL)"
    )
    con.commit()
    con.close()
    return path


def _set_cookie(db: Path, host: str, name: str, value: bytes, when: int) -> None:
    import sqlite3

    con = sqlite3.connect(db)
    con.execute(
        "INSERT INTO cookies VALUES (?, ?, ?, '', ?, '/', 0)", (when, host, name, value)
    )
    con.commit()
    con.close()


class TestSessionCookies:
    def test_the_sites_sign_in_cookies_are_found_by_name_and_host(self, tmp_path):
        db = _cookie_db(tmp_path)
        _set_cookie(db, ".claude.ai", "sessionKey", b"\x01secret", 1)
        _set_cookie(db, "claude.ai", "lastActiveOrg", b"\x02", 2)
        _set_cookie(db, "accounts.google.com", "sessionKey", b"\x03", 3)
        _set_cookie(db, "notclaude.ai", "sessionKey", b"\x04", 4)
        assert pma.session_cookies(tmp_path, "claude.ai") == {(".claude.ai", "", b"\x01secret", 1)}

    def test_the_older_place_is_looked_in_too(self, tmp_path):
        db = _cookie_db(tmp_path, "Default/Cookies")
        _set_cookie(db, "127.0.0.1", "sessionKey", b"", 5)
        assert pma.session_cookies(tmp_path, "127.0.0.1") == {("127.0.0.1", "", b"", 5)}

    def test_no_store_or_a_broken_one_is_no_cookies(self, tmp_path):
        assert pma.session_cookies(tmp_path, "claude.ai") == set()
        broken = tmp_path / "Default" / "Network" / "Cookies"
        broken.parent.mkdir(parents=True)
        broken.write_bytes(b"not a database")
        assert pma.session_cookies(tmp_path, "claude.ai") == set()

    def test_a_new_sign_in_is_told_from_a_stale_one(self, tmp_path):
        db = _cookie_db(tmp_path)
        _set_cookie(db, ".claude.ai", "sessionKey", b"old", 1)
        before = pma.session_cookies(tmp_path, "claude.ai")
        assert not (pma.session_cookies(tmp_path, "claude.ai") - before)
        _set_cookie(db, ".claude.ai", "sessionKey", b"new", 2)
        assert pma.session_cookies(tmp_path, "claude.ai") - before == {(".claude.ai", "", b"new", 2)}


class _Running:
    """A plain window's process that stays up until closed."""

    def __init__(self):
        self.closed = False
        self.pid = 4242

    def poll(self):
        return 0 if self.closed else None


def _snss(profile: Path, name: str, *pages, age: float = 0) -> Path:
    """A session-restore file as Chrome writes it, as far as the addresses go.

    Each page is one navigation command: the page the tab is on, then, when
    given as ``(page, asked_for)``, the page that was asked for and
    redirected away from.
    """
    path = profile / "Default" / "Sessions" / name
    path.parent.mkdir(parents=True, exist_ok=True)

    def string(text: str) -> bytes:
        raw = text.encode()
        return len(raw).to_bytes(4, "little") + raw + b"\x00" * (-len(raw) % 4)

    commands = []
    for page in pages:
        landed, asked = page if isinstance(page, tuple) else (page, "")
        payload = b"\x00" * 8 + string(landed) + string("title") + string("") + (string(asked) if asked else b"")
        commands.append((len(payload) + 1).to_bytes(2, "little") + b"\x06" + payload)
    path.write_bytes(b"SNSS\x03\x00\x00\x00" + b"".join(commands))
    if age:
        then = time.time() - age
        os.utime(path, (then, then))
    return path


def _history(profile: Path, *visits: tuple[str, int]) -> Path:
    """A History file as Chrome writes it, as far as the visits go: each a page and its Chrome time."""
    path = profile / "Default" / "History"
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    try:
        con.executescript(
            "CREATE TABLE IF NOT EXISTS urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR,"
            " visit_count INTEGER DEFAULT 0, typed_count INTEGER DEFAULT 0, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0);"
            "CREATE TABLE IF NOT EXISTS visits(id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL,"
            " visit_time INTEGER NOT NULL, from_visit INTEGER, transition INTEGER DEFAULT 0);"
        )
        for page, when in visits:
            row = con.execute("SELECT id FROM urls WHERE url = ?", (page,)).fetchone()
            url_id = row[0] if row else con.execute(
                "INSERT INTO urls(url, title, last_visit_time) VALUES (?, '', ?)", (page, when)
            ).lastrowid
            con.execute("INSERT INTO visits(url, visit_time) VALUES (?, ?)", (url_id, when))
        con.commit()
    finally:
        con.close()
    return path


class TestHistoryPages:
    def test_chrome_counts_microseconds_from_1601(self):
        assert pma.chrome_time(0) == 11644473600 * 1_000_000
        assert pma.chrome_time(1.5) - pma.chrome_time(0) == 1_500_000

    def test_only_visits_after_the_window_opened_count_oldest_first(self, tmp_path):
        since = pma.chrome_time(1_700_000_000)
        _history(
            tmp_path,
            ("https://claude.ai/new", since - 1),  # an earlier session's
            ("https://claude.ai/login?returnTo=%2F", since + 3_000_000),
            ("https://claude.ai/new", since + 5_000_000),
            ("file:///C:/x.html", since + 1_000_000),
        )
        assert pma.history_pages(tmp_path, since) == [
            "file:///C:/x.html",
            "https://claude.ai/login?returnTo=%2F",
            "https://claude.ai/new",
        ]
        assert pma.signed_in_page(pma.history_pages(tmp_path, since), "claude.ai") == "https://claude.ai/new"

    def test_no_history_or_an_unreadable_one_is_no_pages(self, tmp_path):
        assert pma.history_pages(tmp_path, 0) == []
        path = tmp_path / "Default" / "History"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"not a database")
        assert pma.history_pages(tmp_path, 0) == []

    def test_the_file_is_read_from_a_copy(self, tmp_path, monkeypatch):
        # Chrome may be mid-write; the copy is what is opened, and it is gone afterwards.
        _history(tmp_path, ("https://claude.ai/new", 10))
        opened = []
        real = pma.sqlite3.connect
        monkeypatch.setattr(pma.sqlite3, "connect", lambda p, *a, **k: opened.append(Path(p)) or real(p, *a, **k))
        assert pma.history_pages(tmp_path, 5) == ["https://claude.ai/new"]
        assert opened and opened[0] != tmp_path / "Default" / "History" and not opened[0].exists()


class TestSessionPages:
    def test_only_the_new_browser_sessions_files_are_read(self, tmp_path):
        # The earlier session (the driven window's check) left a file; it is
        # not touched again, so its pages do not count.
        _snss(tmp_path, "Session_1", "https://claude.ai/", "https://claude.ai/new")
        before = pma.session_files(tmp_path)
        assert pma.session_pages(tmp_path, before) == []
        _snss(tmp_path, "Session_2", "file:///C:/x.html", "https://claude.ai/login?returnTo=%2F", "https://claude.ai/new")
        assert pma.session_pages(tmp_path, before) == ["https://claude.ai/login?returnTo=%2F", "https://claude.ai/new"]

    def test_a_file_written_again_counts(self, tmp_path):
        # The older layout keeps one file name and writes it afresh each session.
        path = tmp_path / "Default" / "Current Session"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"SNSS\x01\x00\x00\x00..http://127.0.0.1:8080/\x00")
        before = pma.session_files(tmp_path)
        assert pma.session_pages(tmp_path, before) == []
        path.write_bytes(b"SNSS\x01\x00\x00\x00..http://127.0.0.1:8080/new\x00\x00\x00")
        assert pma.session_pages(tmp_path, before) == ["http://127.0.0.1:8080/new"]

    def test_the_page_asked_for_does_not_count_when_a_redirect_landed_elsewhere(self, tmp_path):
        before = pma.session_files(tmp_path)
        _snss(tmp_path, "Session_1", ("https://claude.ai/api/challenge_redirect?to=%2F", "https://claude.ai/"))
        assert pma.session_pages(tmp_path, before) == ["https://claude.ai/api/challenge_redirect?to=%2F"]
        assert pma.signed_in_page(pma.session_pages(tmp_path, before), "claude.ai") == ""
        _snss(tmp_path, "Session_1", ("https://claude.ai/api/challenge_redirect?to=%2F", "https://claude.ai/"), "https://claude.ai/")
        assert pma.signed_in_page(pma.session_pages(tmp_path, before), "claude.ai") == "https://claude.ai/"

    def test_a_file_that_is_not_a_session_file_is_read_whole(self, tmp_path):
        before = pma.session_files(tmp_path)
        path = tmp_path / "Default" / "Current Session"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"junk https://claude.ai/new junk https://claude.ai/login")
        assert pma.session_pages(tmp_path, before) == ["https://claude.ai/new", "https://claude.ai/login"]

    def test_no_files_is_no_pages(self, tmp_path):
        assert pma.session_files(tmp_path) == {}
        assert pma.session_pages(tmp_path, {}) == []

    @pytest.mark.parametrize(
        "page",
        [
            "https://claude.ai/login",
            "https://claude.ai/login?returnTo=%2Fnew",
            "https://claude.ai/magic-link?token=x",
            "https://claude.ai/oauth/google",
            "https://claude.ai/api/auth/callback?code=1",
            "https://accounts.google.com/o/oauth2/auth",
            "https://notclaude.ai/new",
            "file:///C:/Users/greg/.claude-swap-backup/browser-profiles/x.sign-in.html",
        ],
    )
    def test_pages_a_signed_out_tab_can_be_on_do_not_count(self, page):
        assert pma.signed_in_page([page], "claude.ai") == ""

    @pytest.mark.parametrize("page", ["https://claude.ai/new", "https://claude.ai/", "https://claude.ai/projects", "https://claude.ai/onboarding", "https://CLAUDE.ai/chats"])
    def test_pages_only_a_signed_in_tab_reaches_count(self, page):
        assert pma.signed_in_page(["https://claude.ai/login", page], "claude.ai") == page

    def test_the_mock_site_counts_by_its_host_and_port(self):
        assert pma.signed_in_page(["http://127.0.0.1:8080/new"], "127.0.0.1") == "http://127.0.0.1:8080/new"


class TestWaitForSignIn:
    def test_the_window_is_closed_once_a_signed_in_page_shows(self, monkeypatch, tmp_path):
        looks = iter([[], ["https://claude.ai/login"], ["https://claude.ai/login", "https://claude.ai/new"]])
        monkeypatch.setattr(pma, "session_pages", lambda profile, before: next(looks))
        monkeypatch.setattr(pma, "session_cookies", lambda profile, host: set())
        process = _Running()
        closed = []
        monkeypatch.setattr(pma, "_close_gently", lambda p, **_:closed.append(p) or setattr(p, "closed", True))
        monkeypatch.setattr(pma.time, "sleep", lambda s: None)
        said = []
        pma._wait_for_sign_in(process, tmp_path, "claude.ai", set(), {}, time.monotonic() + 60, said.append)
        assert closed == [process]
        assert said == ["Signed in. Closing that window..."]

    def test_the_window_is_closed_once_the_history_shows_a_signed_in_page(self, monkeypatch, tmp_path):
        # Windows: the session files and the cookie store cannot be read
        # while the browser runs, and the history is the sign that is left.
        looks = iter([[], ["https://claude.ai/login"], ["https://claude.ai/login", "https://claude.ai/new"]])
        monkeypatch.setattr(pma, "session_pages", lambda profile, before: [])
        monkeypatch.setattr(pma, "session_cookies", lambda profile, host: set())
        asked = []
        monkeypatch.setattr(pma, "history_pages", lambda profile, since: asked.append(since) or next(looks))
        process = _Running()
        closed = []
        monkeypatch.setattr(pma, "_close_gently", lambda p, **_:closed.append(p) or setattr(p, "closed", True))
        monkeypatch.setattr(pma.time, "sleep", lambda s: None)
        pma._wait_for_sign_in(process, tmp_path, "claude.ai", set(), {}, time.monotonic() + 60, since=7)
        assert closed == [process]
        assert asked == [7, 7, 7]

    def test_the_history_is_not_read_without_a_time_to_count_from(self, monkeypatch, tmp_path):
        monkeypatch.setattr(pma, "session_pages", lambda profile, before: ["https://claude.ai/new"])
        monkeypatch.setattr(pma, "session_cookies", lambda profile, host: set())
        monkeypatch.setattr(pma, "history_pages", lambda profile, since: pytest.fail("read the history"))
        monkeypatch.setattr(pma, "_close_gently", lambda p, **_:setattr(p, "closed", True))
        pma._wait_for_sign_in(_Running(), tmp_path, "claude.ai", set(), {}, time.monotonic() + 60)

    def test_the_window_is_closed_once_the_sign_in_cookie_is_in(self, monkeypatch, tmp_path):
        looks = iter([set(), set(), {("claude.ai", "", b"x", 9)}])
        monkeypatch.setattr(pma, "session_pages", lambda profile, before: [])
        monkeypatch.setattr(pma, "session_cookies", lambda profile, host: next(looks))
        process = _Running()
        closed = []
        monkeypatch.setattr(pma, "_close_gently", lambda p, **_:closed.append(p) or setattr(p, "closed", True))
        monkeypatch.setattr(pma.time, "sleep", lambda s: None)
        pma._wait_for_sign_in(process, tmp_path, "claude.ai", set(), {}, time.monotonic() + 60)
        assert closed == [process]

    def test_a_stale_cookie_does_not_count(self, monkeypatch, tmp_path):
        stale = {("claude.ai", "", b"old", 1)}
        monkeypatch.setattr(pma, "session_pages", lambda profile, before: [])
        monkeypatch.setattr(pma, "session_cookies", lambda profile, host: set(stale))
        monkeypatch.setattr(pma, "_close_gently", lambda p, **_:pytest.fail("closed on a stale cookie"))
        process = _Running()
        clock = iter([0, 0, 100])
        monkeypatch.setattr(pma.time, "monotonic", lambda: next(clock, 100))
        monkeypatch.setattr(pma.time, "sleep", lambda s: None)
        with pytest.raises(cdp.BrowserError, match="Nobody signed in there in time"):
            pma._wait_for_sign_in(process, tmp_path, "claude.ai", stale, {}, 50)

    def test_the_check_window_is_closed_once_a_page_of_the_site_shows(self, monkeypatch, tmp_path):
        profile = tmp_path / "p"
        before = pma.session_files(profile)
        _snss(profile, "Session_2", "https://claude.ai/api/challenge_redirect?to=%2F", "https://claude.ai/")
        closed = []
        monkeypatch.setattr(pma, "_close_gently", lambda process, timeout=15.0, **_: closed.append(process))
        said = []
        running = _Running()
        pma._wait_for_sign_in(running, profile, "claude.ai", set(), before, time.monotonic() + 5, said.append, poll=0, what="check")
        assert closed == [running]
        assert said == ["claude.ai shows there: the check passed. Closing that window..."]

    def test_a_check_window_still_on_the_check_in_time_is_an_error(self, monkeypatch, tmp_path):
        profile = tmp_path / "p"
        before = pma.session_files(profile)
        _snss(profile, "Session_2", "https://claude.ai/api/challenge_redirect?to=%2F")
        with pytest.raises(cdp.BrowserError, match="The check did not pass in that window in time"):
            pma._wait_for_sign_in(_Running(), profile, "claude.ai", set(), before, time.monotonic() - 1, poll=0, what="check")

    def test_a_window_the_person_closes_is_enough(self, monkeypatch, tmp_path):
        monkeypatch.setattr(pma, "session_pages", lambda profile, before: pytest.fail("looked at the session"))
        process = _Running()
        process.closed = True
        pma._wait_for_sign_in(process, tmp_path, "claude.ai", set(), {}, time.monotonic() + 60)


class _Closable:
    """A window that remembers whether it was closed, and how."""

    def __init__(self, account=None):
        self.account = account
        self.signed_in_as = ""
        self.closed = False
        self.page_closed = False
        self.page = type("P", (), {"close": lambda _self: setattr(self, "page_closed", True)})()

    def close(self):
        self.closed = True


class TestOneWindowAtATime:
    def test_each_account_signs_in_alone_and_its_window_is_closed(self, monkeypatch, tmp_path):
        order = []

        def sign_in(account, root, site, executable, **_):
            w = _Closable(account)
            w.signed_in_as = account.email.upper()
            order.append(w)
            assert all(earlier.closed for earlier in order[:-1])  # nothing else open meanwhile
            return w

        monkeypatch.setattr(pma, "sign_in", sign_in)
        a = pma.Account("source", "2", "a@example.com")
        b = pma.Account("destination", "1", "b@example.com")
        assert pma.sign_everyone_in([a, b], tmp_path, "https://claude.ai", "chrome") == ["A@EXAMPLE.COM", "B@EXAMPLE.COM"]
        assert [w.closed for w in order] == [True, True]

    def test_a_step_runs_in_its_own_window_which_is_closed_after(self, monkeypatch, tmp_path):
        opened = []
        monkeypatch.setattr(pma, "open_window", lambda account, *a, **k: opened.append(_Closable(account)) or opened[-1])
        said = []
        account = pma.Account("source", "2", "a@example.com")
        out = pma._in_window(account, "a@example.com", tmp_path, "https://claude.ai", "chrome", "export", lambda w, carry: ("done", w, carry), say=said.append)
        assert out == ("done", opened[0], "") and opened[0].signed_in_as == "a@example.com"
        assert opened[0].closed
        assert said == ["A browser window just opened for a@example.com to run the export. Leave it alone; cswap closes it when the export is done."]

    def test_a_window_that_goes_away_is_opened_again_once(self, monkeypatch, tmp_path):
        opened = []
        monkeypatch.setattr(pma, "open_window", lambda account, *a, **k: opened.append(_Closable(account)) or opened[-1])
        said = []
        tries = []

        def work(window, carry):
            tries.append((window, carry))
            if len(tries) == 1:
                raise cdp.PageClosed("the browser connection broke")
            return "imported"

        account = pma.Account("destination", "1", "b@example.com")
        out = pma._in_window(account, "b@example.com", tmp_path, "https://claude.ai", "chrome", "import", work, say=said.append)
        assert out == "imported" and len(opened) == 2 and [w for w, _ in tries] == opened
        assert opened[0].closed and opened[1].closed
        assert said[1] == "The window went away (the browser connection broke). Opening it again and carrying on with the import."

    def test_a_step_that_stopped_with_a_project_made_carries_on_in_it(self, monkeypatch, tmp_path):
        opened = []
        monkeypatch.setattr(pma, "open_window", lambda account, *a, **k: opened.append(_Closable(account)) or opened[-1])
        tries = []

        def work(window, carry):
            tries.append(carry)
            if len(tries) == 1:
                raise pma.Interrupted("the window went away (the tab was closed)", url="https://claude.ai/code/project/chan_01NEW", gone=True)
            return carry

        account = pma.Account("destination", "1", "b@example.com")
        out = pma._in_window(account, "", tmp_path, "https://claude.ai", "chrome", "import", work)
        assert out == "https://claude.ai/code/project/chan_01NEW" and tries == ["", "https://claude.ai/code/project/chan_01NEW"]

    def test_a_window_that_keeps_going_away_is_an_error_naming_the_project(self, monkeypatch, tmp_path):
        monkeypatch.setattr(pma, "open_window", lambda account, *a, **k: _Closable(account))

        def work(window, carry):
            raise pma.Interrupted("the window went away (the tab was closed)", url="https://claude.ai/code/project/chan_01NEW", gone=True)

        with pytest.raises(pma.Interrupted, match="The import stopped part-way: the window went away") as info:
            pma._in_window(pma.Account("destination", "1", "b@example.com"), "", tmp_path, "https://claude.ai", "chrome", "import", work)
        assert info.value.url == "https://claude.ai/code/project/chan_01NEW" and info.value.gone

    def test_the_sites_check_is_passed_in_a_plain_window_and_the_step_carried_on(self, monkeypatch, tmp_path):
        opened = []
        monkeypatch.setattr(pma, "open_window", lambda account, *a, **k: opened.append(_Closable(account)) or opened[-1])
        passes = []
        monkeypatch.setattr(pma, "_person_passes_check", lambda account, *a, **k: passes.append(account))
        said = []
        tries = []

        def work(window, carry):
            tries.append(carry)
            if len(tries) == 1:
                raise pma.Interrupted("claude.ai's security check took that window over in the middle of the import", url="https://claude.ai/code/project/chan_01NEW", checked=True)
            return "done"

        account = pma.Account("destination", "1", "b@example.com")
        out = pma._in_window(account, "", tmp_path, "https://claude.ai", "chrome", "import", work, say=said.append)
        assert out == "done" and tries == ["", "https://claude.ai/code/project/chan_01NEW"]
        assert passes == [account] and opened[0].closed and opened[1].closed
        assert said[1] == "Claude.ai's security check took that window over in the middle of the import. Closing that window."

    def test_a_check_that_comes_back_after_the_pass_stops_the_step(self, monkeypatch, tmp_path):
        monkeypatch.setattr(pma, "open_window", lambda account, *a, **k: _Closable(account))
        passes = []
        monkeypatch.setattr(pma, "_person_passes_check", lambda account, *a, **k: passes.append(account))

        def work(window, carry):
            raise pma.Interrupted("the check", url=carry or "https://claude.ai/code/project/chan_01NEW", checked=True)

        with pytest.raises(pma.Interrupted, match="asked for its security check again in the b@example.com window right after it passed in a normal window") as info:
            pma._in_window(pma.Account("destination", "1", "b@example.com"), "", tmp_path, "https://claude.ai", "chrome", "import", work)
        assert len(passes) == 1 and info.value.url == "https://claude.ai/code/project/chan_01NEW" and info.value.checked

    def test_a_failed_step_leaves_its_window_open_to_look_at(self, monkeypatch, tmp_path):
        opened = []
        monkeypatch.setattr(pma, "open_window", lambda account, *a, **k: opened.append(_Closable(account)) or opened[-1])

        def work(window, carry):
            raise ValidationError("no such project")

        with pytest.raises(ValidationError):
            pma._in_window(pma.Account("source", "2", "a@example.com"), "", tmp_path, "https://claude.ai", "chrome", "export", work)
        assert opened[0].page_closed and not opened[0].closed

    def test_keep_open_leaves_the_window_up(self, monkeypatch, tmp_path):
        opened = []
        monkeypatch.setattr(pma, "open_window", lambda account, *a, **k: opened.append(_Closable(account)) or opened[-1])
        pma._in_window(pma.Account("destination", "1", "b@example.com"), "", tmp_path, "https://claude.ai", "chrome", "import", lambda w, carry: 1, keep_open=True)
        assert opened[0].page_closed and not opened[0].closed


class _ScriptPage:
    """A tab running a script, as ``_follow`` sees it: its states in turn, then what the tab is on."""

    def __init__(self, states, then="reloaded"):
        self.states = list(states)
        self.then = then  # "reloaded", "check" or "closed" once the states run out
        self.pumped = 0.0

    def evaluate(self, expression, **_):
        if expression is pma._CHALLENGE:
            return self.then == "check"
        if expression.startswith("window.__cswap ?"):
            if self.states:
                return self.states.pop(0)
            if self.then == "closed":
                raise cdp.PageClosed("the tab was closed")
            return None
        return True

    def pump(self, seconds):
        self.pumped += seconds


class TestFollow:
    READY = {"ready": True, "status": ""}

    def test_the_check_taking_the_window_over_stops_the_script_with_its_link(self, monkeypatch):
        monkeypatch.setattr(pma.time, "monotonic", lambda: 0)
        page = _ScriptPage([self.READY, {"ready": True, "status": "Creating the project...", "link": "https://claude.ai/code/project/chan_01NEW"}], then="check")
        said = []
        with pytest.raises(pma.Interrupted, match="claude.ai's security check took that window over in the middle of the import") as info:
            pma._follow(page, said.append, timeout=10, fail_words=("Import failed",), what="import")
        assert info.value.url == "https://claude.ai/code/project/chan_01NEW" and info.value.checked and not info.value.gone
        assert said == ["  Creating the project..."]

    def test_a_reload_is_told_from_the_check_after_a_few_looks(self, monkeypatch):
        monkeypatch.setattr(pma.time, "monotonic", lambda: 0)
        page = _ScriptPage([self.READY, {"ready": True, "link": "https://claude.ai/code/project/chan_01NEW"}], then="reloaded")
        with pytest.raises(pma.Interrupted, match="the page was reloaded in the middle of the import") as info:
            pma._follow(page, pma._quiet, timeout=10, fail_words=(), what="import")
        assert info.value.url == "https://claude.ai/code/project/chan_01NEW" and not info.value.checked
        assert page.pumped >= 5.0

    def test_a_tab_that_closes_stops_the_script_with_its_link(self, monkeypatch):
        monkeypatch.setattr(pma.time, "monotonic", lambda: 0)
        page = _ScriptPage([self.READY, {"ready": True, "link": "https://claude.ai/code/project/chan_01NEW"}], then="closed")
        with pytest.raises(pma.Interrupted, match="the window went away") as info:
            pma._follow(page, pma._quiet, timeout=10, fail_words=(), what="import")
        assert info.value.url == "https://claude.ai/code/project/chan_01NEW" and info.value.gone

    def test_a_script_that_ends_is_returned(self, monkeypatch):
        monkeypatch.setattr(pma.time, "monotonic", lambda: 0)
        page = _ScriptPage([self.READY, {"ready": True, "status": "Done", "done": True, "link": "x"}])
        assert pma._follow(page, pma._quiet, timeout=10, fail_words=())["done"] is True


class TestCarryOn:
    @pytest.mark.parametrize(
        ("given", "want"),
        [
            ("chan_01S5i3JHP4CH2ufpjq1y4CXB", "chan_01S5i3JHP4CH2ufpjq1y4CXB"),
            ("https://claude.ai/code/project/chan_01S5i3JHP4CH2ufpjq1y4CXB", "chan_01S5i3JHP4CH2ufpjq1y4CXB"),
            ("https://claude.ai/code/project/chan_01S5i3JHP4CH2ufpjq1y4CXB/", "chan_01S5i3JHP4CH2ufpjq1y4CXB"),
            ("https://claude.ai/code/project/chan_01S5i3JHP4CH2ufpjq1y4CXB?x=1", "chan_01S5i3JHP4CH2ufpjq1y4CXB"),
            ("beethoven", ""),
            ("https://claude.ai/project/aaaaaaaa-0000-4000-8000-000000000001", ""),
            ("cse_01ABCDEFGHIJ", ""),
        ],
    )
    def test_a_code_project_is_known_by_its_id_or_address(self, given, want):
        assert pma.code_project_id(given) == want

    def test_something_else_cannot_be_carried_on_in(self, tmp_path):
        with pytest.raises(ValidationError, match="is not the address or id of a Claude Code project"):
            pma.run_import(_FakeWindow(), "https://claude.ai", pm.ExportCheck(path=tmp_path), into="Recipes")

    def _export(self, folder: Path, dirname: str, source: str, *, name: str = "beethoven", complete: bool = True, age: float = 0) -> Path:
        path = folder / dirname
        path.mkdir(parents=True)
        manifest = {
            "format": pm.MANIFEST_FORMAT, "version": pm.MANIFEST_VERSION, "kind": "code", "name": name,
            "source": {"id": source}, "files": [{"path": "files/a.txt", "bytes": 2}],
        }
        (path / "files").mkdir()
        if complete:
            (path / "files" / "a.txt").write_text("hi")
        (path / pm.MANIFEST_NAME).write_text(json.dumps(manifest))
        when = time.time() - age
        os.utime(path / pm.MANIFEST_NAME, (when, when))
        return path

    def test_the_export_the_last_run_used_is_taken_when_whole(self, tmp_path):
        kept = self._export(tmp_path, "beethoven", "chan_01SOURCE000")
        self._export(tmp_path, "beethoven (2)", "chan_01SOURCE000")
        found = pma.matching_export(tmp_path, "beethoven", str(kept))
        assert found is not None and found.path == kept

    def test_otherwise_the_newest_whole_export_of_the_project_is_taken(self, tmp_path):
        self._export(tmp_path, "beethoven", "chan_01SOURCE000", age=100)
        newest = self._export(tmp_path, "beethoven (2)", "chan_01SOURCE000", age=10)
        self._export(tmp_path, "beethoven (3)", "chan_01SOURCE000", complete=False)
        self._export(tmp_path, "other", "chan_01OTHER0000", name="other")
        for project in ("beethoven", "BEETHOVEN", "chan_01SOURCE000", "https://claude.ai/code/project/chan_01SOURCE000"):
            found = pma.matching_export(tmp_path, project, str(tmp_path / "gone"))
            assert found is not None and found.path == newest, project
        # No project named (the account has one): the newest export of any.
        assert pma.matching_export(tmp_path, "").path == tmp_path / "other"
        assert pma.matching_export(tmp_path, "chan_01NONE00000") is None
        assert pma.matching_export(tmp_path, "recipes") is None
        assert pma.matching_export(tmp_path / "missing", "beethoven") is None


class _Forced:
    """A plain window's process that cannot be asked to close, only ended."""

    pid = 4242

    def __init__(self):
        self.terminated = False

    def poll(self):
        return 1 if self.terminated else None

    def send_signal(self, sig):
        raise OSError("no such process")

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 1


class TestCloseGently:
    @pytest.fixture
    def nothing_to_ask(self, monkeypatch):
        # On Windows the gentle ways are commands; here they find no window.
        monkeypatch.setattr(pma.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a[0], 1, "False", ""))
        monkeypatch.setattr(pma.time, "sleep", lambda s: None)

    def test_the_store_stamp_follows_the_file(self, tmp_path):
        assert pma.store_stamp(tmp_path) is None
        db = tmp_path / "Default" / "Network" / "Cookies"
        db.parent.mkdir(parents=True)
        db.write_bytes(b"one")
        first = pma.store_stamp(tmp_path)
        assert first is not None and first[0] == 3
        db.write_bytes(b"three")
        assert pma.store_stamp(tmp_path) != first

    def test_a_close_that_cannot_be_gentle_waits_for_the_store_to_be_written(self, monkeypatch, tmp_path, nothing_to_ask):
        # A headless browser has no window to ask, and ending its process
        # would lose a sign-in the cookie store has not been written with.
        stamps = iter([(1, 1), (1, 1), (2, 2)])
        monkeypatch.setattr(pma, "store_stamp", lambda profile: next(stamps))
        process = _Forced()
        pma._close_gently(process, profile=tmp_path, stamp=(1, 1))
        assert process.terminated
        assert next(stamps, "all looked at") == "all looked at"

    def test_a_close_that_cannot_be_gentle_gives_the_store_half_a_minute_at_most(self, monkeypatch, tmp_path, nothing_to_ask):
        monkeypatch.setattr(pma, "store_stamp", lambda profile: (1, 1))
        clock = iter([0, 0, 10, 20, 40])
        monkeypatch.setattr(pma.time, "monotonic", lambda: next(clock, 40))
        process = _Forced()
        pma._close_gently(process, profile=tmp_path, stamp=(1, 1))
        assert process.terminated

    def test_a_close_that_cannot_be_gentle_does_not_wait_without_a_profile(self, monkeypatch, nothing_to_ask):
        monkeypatch.setattr(pma, "store_stamp", lambda profile: pytest.fail("looked at the store"))
        process = _Forced()
        pma._close_gently(process)
        assert process.terminated

    def test_a_process_is_asked_to_stop_and_then_made_to(self):
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        try:
            pma._close_gently(process, timeout=5)
            assert process.poll() is not None
        finally:
            if process.poll() is None:
                process.kill()

    def test_a_process_already_gone_is_left_alone(self):
        process = subprocess.Popen([sys.executable, "-c", "pass"])
        process.wait(30)
        pma._close_gently(process, timeout=5)
        assert process.returncode == 0


class _ChallengePage:
    """A tab that is on the site's security check for the first ``rounds`` looks."""

    def __init__(self, rounds: int, href: str = "https://claude.ai/api/challenge_redirect?to=%2F"):
        self.rounds = rounds
        self.href = href
        self.pumped = 0.0

    def evaluate(self, expression, **_):
        if expression is pma._CHALLENGE:
            self.rounds -= 1
            return self.rounds >= 0
        if expression.startswith("[location.href"):
            return [self.href, "complete"]
        return {"signedIn": True, "email": "a@example.com", "orgs": []}

    def pump(self, seconds):
        self.pumped += seconds

    def wait_loaded(self, prefix, timeout=60.0):
        return self.href


class TestSecurityCheck:
    def test_a_tab_not_on_the_check_goes_straight_on(self):
        said = []
        assert pma._pass_challenge(_ChallengePage(0), said.append) is False
        assert said == []

    def test_the_check_is_waited_out_and_the_person_told(self):
        said = []
        page = _ChallengePage(3)
        assert pma._pass_challenge(page, said.append) is True
        assert said[0].startswith('claude.ai is running its security check in that window ("Performing security verification")')
        assert "gives the check 30 seconds to pass by itself, and otherwise opens a normal window for you to pass it in" in said[0]
        assert said[1] == "The security check passed; carrying on."
        assert page.pumped == 4.0  # two looks that still saw it, two seconds apart

    def test_a_check_that_does_not_pass_by_itself_is_handed_to_the_person(self, monkeypatch):
        clock = iter([0, 0, 1000])
        monkeypatch.setattr(pma.time, "monotonic", lambda: next(clock, 1000))
        with pytest.raises(pma.Interrupted, match="security check did not pass in that window, and cswap does not try to get around it") as info:
            pma._pass_challenge(_ChallengePage(100), patience=600)
        assert info.value.checked and not info.value.gone and info.value.url == ""

    def test_the_person_passes_it_in_a_plain_window_on_the_profile(self, monkeypatch, tmp_path):
        plain = []
        monkeypatch.setattr(pma, "launch_plain", lambda exe, profile, url, **kw: plain.append((profile, url)) or _Exited())
        monkeypatch.setattr(pma.time, "sleep", lambda s: None)
        said = []
        account = pma.Account("destination", "1", "b@example.com")
        pma._person_passes_check(account, tmp_path, "https://claude.ai", "chrome", say=said.append, label_seconds=1)
        assert plain == [(account.profile_dir(tmp_path), pma.label_page(account, "https://claude.ai", tmp_path, 1, check=True))]
        assert said[0].startswith("That check does not pass in a driven window. A normal browser window just opened for b@example.com (the DESTINATION account) instead; it says so in blue.")
        assert "if the check shows a box to tick, tick it" in said[0]
        assert said[-1] == "Opening the b@example.com window again."

    def test_a_tab_on_the_check_is_not_taken_for_signed_out(self):
        said = []
        page = _ChallengePage(2)
        found = pma.who_is_signed_in(page, "https://claude.ai", say=said.append)
        assert found == pma.SignedIn(True, "a@example.com", ())
        assert said[-1] == "The security check passed; carrying on."

    def test_a_tab_between_pages_is_not_on_the_check(self):
        class Between:
            def evaluate(self, *a, **k):
                raise cdp.BrowserError("the browser did not answer Runtime.evaluate in time")

        assert pma._challenged(Between()) is False


class TestSignedIn:
    def test_the_email_decides_when_the_site_gives_one(self):
        account = pma.Account("source", "2", "a@example.com", "org-1")
        assert pma.SignedIn(True, "A@EXAMPLE.com", ("org-9",)).matches(account) is True
        assert pma.SignedIn(True, "b@example.com", ("org-1",)).matches(account) is False

    def test_the_organization_decides_otherwise(self):
        account = pma.Account("source", "2", "a@example.com", "org-1")
        assert pma.SignedIn(True, "", ("org-1",)).matches(account) is True
        assert pma.SignedIn(True, "", ("org-2",)).matches(account) is False

    def test_nothing_to_go_on_is_no_verdict(self):
        assert pma.SignedIn(True).matches(pma.Account("source", "2", "a@example.com", "org-1")) is None
        assert pma.SignedIn(True, "", ("org-1",)).matches(pma.Account("source", "2", "a@example.com")) is None
        assert pma.SignedIn(True, "a@example.com").matches(pma.Account("source", "2", "")) is None

    def test_signed_out_matches_nobody(self):
        assert pma.SignedIn(False, "a@example.com").matches(pma.Account("source", "2", "a@example.com")) is False


class TestForget:
    def test_the_profiles_are_removed(self, tmp_path):
        a = pma.Account("source", "2", "a@example.com")
        b = pma.Account("destination", "1", "b@example.com")
        for acct in (a, b):
            (acct.profile_dir(tmp_path) / "Default").mkdir(parents=True)
            (acct.profile_dir(tmp_path) / "Default" / "Cookies").write_bytes(b"x")
        said = []
        gone = pma.forget([a, b], tmp_path, said.append)
        assert gone == [a.profile_dir(tmp_path), b.profile_dir(tmp_path)]
        assert not a.profile_dir(tmp_path).exists() and not b.profile_dir(tmp_path).exists()
        assert said == ["Forgot the sign-in for a@example.com.", "Forgot the sign-in for b@example.com."]

    def test_a_profile_that_never_existed_is_skipped(self, tmp_path):
        a = pma.Account("source", "2", "a@example.com")
        assert pma.forget([a], tmp_path) == []

    def test_a_profile_the_browser_still_holds_is_tried_again(self, tmp_path, monkeypatch):
        # Windows keeps the files locked for a moment after the browser exits.
        a = pma.Account("source", "2", "a@example.com")
        a.profile_dir(tmp_path).mkdir(parents=True)
        real = pma.shutil.rmtree
        calls = []

        def rmtree(path, ignore_errors=False):
            calls.append(path)
            if len(calls) > 2:
                real(path, ignore_errors=ignore_errors)

        monkeypatch.setattr(pma.shutil, "rmtree", rmtree)
        monkeypatch.setattr(pma.time, "sleep", lambda s: None)
        assert pma._drop_profile(a, tmp_path) is True
        assert len(calls) == 3 and not a.profile_dir(tmp_path).exists()
        with pytest.raises(cdp.BrowserError, match="Could not remove"):
            a.profile_dir(tmp_path).mkdir(parents=True)
            calls.clear()
            pma._drop_profile(a, tmp_path, tries=2)

    def test_a_browser_still_open_on_the_profile_is_closed_first(self, tmp_path, monkeypatch):
        a = pma.Account("source", "2", "a@example.com")
        a.profile_dir(tmp_path).mkdir(parents=True)
        closed = []
        monkeypatch.setattr(cdp.Browser, "_reachable", classmethod(lambda cls, profile: 9222))
        monkeypatch.setattr(cdp.Browser, "close", lambda self, timeout=10.0: closed.append(self.port))
        pma.forget([a], tmp_path)
        assert closed == [9222]
        assert not a.profile_dir(tmp_path).exists()


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

    def test_an_import_that_stops_part_way_is_carried_on_in_the_next_run(self, temp_home, capsys, tmp_path):
        export = pm.ExportCheck(path=tmp_path / "beethoven", name="beethoven", kind="code")
        stop = pma.Interrupted("The import stopped part-way: the window went away (the tab was closed).", url="https://claude.ai/code/project/chan_01NEW", gone=True)
        stop.export = export
        with patch.object(pma, "move", side_effect=stop):
            code, out, err = _run(["auto", "beethoven", "--from", "a@example.com", "--to", "b@example.com"], capsys)
        assert code == 1
        text = out + err
        assert "The import stopped part-way: the window went away (the tab was closed)." in text
        assert "The project https://claude.ai/code/project/chan_01NEW exists and holds what was added before the stop." in text
        assert "To carry on in it (nothing is exported again): cswap project-move auto" in text

        # The next run carries on in that project, with the export it had.
        result = pma.MoveResult(export=export, url="https://claude.ai/code/project/chan_01NEW")
        with patch.object(pma, "move", return_value=result) as moved, \
             patch.object(pma, "matching_export", return_value=export) as matched:
            code, out, _ = _run(["auto"], capsys)
        assert code == 0, out
        assert "Carrying on in https://claude.ai/code/project/chan_01NEW, with the export in" in out
        kwargs = moved.call_args.kwargs
        assert kwargs["into"] == "https://claude.ai/code/project/chan_01NEW" and kwargs["export"] is export
        (folder, project, remembered), _ = matched.call_args
        assert (folder, project, remembered) == (pm.default_exports_folder(), "beethoven", str(export.path))

        # Done: the run after that makes a new project again.
        with patch.object(pma, "move", return_value=result) as moved:
            code, out, _ = _run(["auto"], capsys)
        assert code == 0, out
        assert moved.call_args.kwargs["into"] == "" and moved.call_args.kwargs["export"] is None

    def test_into_names_the_project_and_new_drops_a_remembered_one(self, temp_home, capsys, tmp_path):
        export = pm.ExportCheck(path=tmp_path / "beethoven", name="beethoven", kind="code")
        result = pma.MoveResult(export=export, url="https://claude.ai/code/project/chan_01NEW")
        with patch.object(pma, "move", return_value=result) as moved, \
             patch.object(pma, "matching_export", return_value=None):
            code, out, _ = _run(
                ["auto", "beethoven", "--from", "a@example.com", "--to", "b@example.com", "--into", "chan_01NEW"], capsys
            )
        assert code == 0, out
        assert "so it is exported again first" in out
        assert moved.call_args.kwargs["into"] == "chan_01NEW" and moved.call_args.kwargs["export"] is None

        stop = pma.Interrupted("stopped", url="https://claude.ai/code/project/chan_01NEW", checked=True)
        with patch.object(pma, "move", side_effect=stop), patch.object(pma, "matching_export", return_value=None):
            assert _run(["auto"], capsys)[0] == 1
        with patch.object(pma, "move", return_value=result) as moved:
            code, out, _ = _run(["auto", "--new"], capsys)
        assert code == 0, out
        assert moved.call_args.kwargs["into"] == "" and moved.call_args.kwargs["export"] is None

    def test_new_wins_over_into(self, temp_home, capsys, tmp_path):
        # Both given: the project named may not be in view from the
        # destination login at all, and --new is the way out of that.
        export = pm.ExportCheck(path=tmp_path / "beethoven", name="beethoven", kind="code")
        result = pma.MoveResult(export=export, url="https://claude.ai/code/project/chan_01MADE")
        with patch.object(pma, "move", return_value=result) as moved, \
             patch.object(pma, "matching_export", return_value=export) as matched:
            code, out, _ = _run(
                [
                    "auto", "beethoven", "--from", "a@example.com", "--to", "b@example.com",
                    "--into", "https://claude.ai/code/project/chan_01GONE", "--new",
                ],
                capsys,
            )
        assert code == 0, out
        assert "--new makes a new project, so https://claude.ai/code/project/chan_01GONE is left alone." in out
        assert "Carrying on in" not in out
        assert moved.call_args.kwargs["into"] == "" and moved.call_args.kwargs["export"] is None
        matched.assert_not_called()

    def test_fresh_forgets_the_sign_ins_before_starting(self, temp_home, capsys):
        with patch.object(pma, "login", return_value=["a@example.com", "b@example.com"]), \
             patch.object(pma, "forget", return_value=[]) as forgot:
            code, out, _ = _run(["login", "--fresh", "--from", "a@example.com", "--to", "b@example.com"], capsys)
        assert code == 0, out
        accounts, _root = forgot.call_args.args[:2]
        assert [a.email for a in accounts] == ["a@example.com", "b@example.com"]

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
# Headless. On Linux also without the sandbox that root (CI containers)
# cannot use and without the GPU; on macOS those two flags keep headless
# Chrome from ever opening its first window, so they are left out there.
# The browser's own log is kept, so a browser that never opens its port
# says why in the error. No proxy: the mock is on 127.0.0.1, and on the
# Windows and macOS runners every navigation stayed on about:blank, the
# way one waiting on the system's proxy settings would.
BROWSER_ARGS = [
    *(["--no-sandbox", "--disable-gpu"] if sys.platform.startswith("linux") else []),
    # The tests point HOME at an empty folder, which has no login keychain:
    # Chrome on macOS then waits on the Keychain for its cookie key and no
    # page ever loads. Its stand-in keychain is the one meant for tests.
    *(["--use-mock-keychain"] if sys.platform == "darwin" else []),
    "--no-proxy-server",
    # Chrome 154 asks before a page reaches a local address; headless, nobody
    # answers. Chrome for Testing, unpacked where the runner put it, lacks the
    # folder permissions its sandboxed network service needs on Windows: the
    # service crashed at every start and every navigation ended ERR_ABORTED.
    # The last --disable-features wins, so cdp's own entry is kept.
    "--disable-features=ChromeWhatsNewUI,LocalNetworkAccessChecks,NetworkServiceSandbox",
    "--enable-logging",
    "--v=0",
]
# How long a DevTools command, a sign-in page or a plain window gets before
# a test gives up on it. A minute is generous for a person's machine; CI sets
# CSWAP_TEST_WAIT lower so a browser that never answers fails in seconds,
# not after eleven tests have each waited out a minute.
WAIT = float(os.environ.get("CSWAP_TEST_WAIT", "60"))
# How long a whole sign-in, or the person's pass of the site's check, gets
# in the tests: the wait above a few times over, in place of the half hour
# and the ten minutes a person gets.
SIGN_IN_WAIT = min(90.0, 4 * WAIT)


@pytest.fixture(autouse=True)
def _call_timeout(monkeypatch):
    monkeypatch.setattr(cdp, "CALL_TIMEOUT", WAIT)
    monkeypatch.setattr(pma, "CHALLENGE_PATIENCE", SIGN_IN_WAIT)


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
    # Nobody presses the button on the page the plain window opens on, so
    # the page goes on to the sign-in by itself after a second.
    return pma.sign_in(
        account, root, site, BROWSER, timeout=SIGN_IN_WAIT, say=(said.append if said is not None else pma._quiet),
        headless=True, extra_args=BROWSER_ARGS, wait=wait, label_seconds=1,
    )


def _person_signed_in(site: _Mock, process, logins_before: int = 0) -> None:
    """Wait until the mock's sign-in page has been shown in the plain window."""
    deadline = time.monotonic() + WAIT
    while site.made()["logins"] <= logins_before:
        assert time.monotonic() < deadline, "the sign-in page was never shown"
        assert process.poll() is None, "the sign-in window closed before the page was shown"
        time.sleep(0.2)


def _person_closes(process, profile: Path | None = None, stamp: tuple | None = None) -> int:
    """Close the plain window as a person would, and return the browser's exit code.

    The mock's sign-in page closes its own tab, but that is not always the
    end of the browser: headless Chrome on Windows and macOS stays running
    with no window at all, and Chrome 154 brings the tabs of the profile's
    last window back into the plain one. A person would close the window
    then, and so does this, the way cswap does, with the store's stamp
    from before the sign-in so that a close that cannot be gentle keeps it.
    """
    pma._close_gently(process, profile=profile, stamp=stamp)
    return process.wait(WAIT)


def _person(site: _Mock, profile: Path, logins_before: int = 0):
    """What the person does in the plain window: waits for the sign-in page, then closes the window."""

    def wait(process):
        stamp = pma.store_stamp(profile)
        _person_signed_in(site, process, logins_before)
        _person_closes(process, profile, stamp)

    return wait


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

    # The mock is signed in from the start, as an account cswap knows by its
    # organization: nothing to ask.
    src = _window(pma.Account("source", "2", "", MOCK_ORG), root, source_site.site, said)
    dst = _window(pma.Account("destination", "1", "", MOCK_ORG), root, dest_site.site, said)
    try:
        assert said == []

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
    site = mocks("--signed-out", "--login-as", "src@example.com")
    root = tmp_path / "cswap"
    said: list[str] = []
    account = pma.Account("source", "2", "src@example.com")
    profile = account.profile_dir(root)

    # The mock's sign-in page signs the browser in, and the window is then
    # closed as a person closes it. This only looks on, to see that the
    # window it happened in had no DevTools port.
    closed: list[int] = []

    def looking_on(process):
        stamp = pma.store_stamp(profile)
        _person_signed_in(site, process)
        assert not (profile / cdp.PORT_FILE).exists()  # no DevTools port on this one
        closed.append(_person_closes(process, profile, stamp))

    window = _window(account, root, site.site, said, wait=looking_on)
    try:
        assert window.signed_in_as == "src@example.com"
        assert closed == [0]
        assert site.made()["logins"] == 1
        assert any("sign in to claude.ai as src@example.com" in line and "SOURCE" in line for line in said)
        assert (profile.parent / ("src@example.com" + pma.LABEL_SUFFIX)).is_file()
        assert any(line.startswith("Checking the sign-in") for line in said)
        assert said[-1] == "Signed in as src@example.com (source)."
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
def test_the_sign_in_window_is_closed_by_cswap_once_the_sign_in_is_in(mocks, tmp_path):
    """Nobody closes the window: cswap sees the tab land on a signed-in page and closes it."""
    site = mocks("--signed-out", "--login-as", "src@example.com", "--stay-open")
    root = tmp_path / "cswap"
    said: list[str] = []
    started = time.monotonic()
    window = _window(pma.Account("source", "2", "src@example.com"), root, site.site, said)
    try:
        assert window.signed_in_as == "src@example.com"
        assert "Signed in. Closing that window..." in said
        assert said[-1] == "Signed in as src@example.com (source)."
        # Chrome notes the page in its session files a few seconds after the
        # tab lands on it; the cookie store, the other quick sign, is only
        # written half a minute later. Windows holds the session files while
        # the browser runs, so there the sign is the history, ten seconds
        # on, and a headless window's close then waits for the store.
        if os.name != "nt":
            assert time.monotonic() - started < 25
        assert site.made()["logins"] == 1
    finally:
        window.close()


@real_browser
@pytest.mark.xdist_group("real-browser")
def test_the_sites_security_check_is_waited_out(mocks, tmp_path):
    """The window lands on the check; cswap says so, waits, and goes on once it clears."""
    site = mocks("--challenge", "6")
    root = tmp_path / "cswap"
    said: list[str] = []
    started = time.monotonic()
    window = _window(pma.Account("source", "2", "", MOCK_ORG), root, site.site, said)
    try:
        assert window.signed_in_as == "2"
        assert said[0].startswith("claude.ai is running its security check in that window")
        assert said[1] == "The security check passed; carrying on."
        assert len(said) == 2  # nothing was asked of the person
        assert 5 < time.monotonic() - started < 60
        assert window.page.evaluate("location.pathname", await_promise=False) == "/"
    finally:
        window.close()


@real_browser
@pytest.mark.xdist_group("real-browser")
def test_a_check_the_driven_window_cannot_pass_is_passed_in_a_plain_one(mocks, tmp_path, monkeypatch):
    """The driven window gives up on the check; a plain window passes it; the driven one comes back."""
    site = mocks("--challenge", "8")
    root = tmp_path / "cswap"
    said: list[str] = []
    monkeypatch.setattr(pma, "DRIVEN_CHECK_WAIT", 2.0)
    plain: list[str] = []
    real = pma.launch_plain
    monkeypatch.setattr(pma, "launch_plain", lambda exe, profile, url, **kw: plain.append(url) or real(exe, profile, url, **kw))
    window = _window(pma.Account("source", "2", "", MOCK_ORG), root, site.site, said)
    try:
        assert window.signed_in_as == "2"
        assert said[0].startswith("claude.ai is running its security check in that window")
        assert said[1].startswith("That check does not pass in a driven window. A normal browser window just opened for 2 (the SOURCE account) instead")
        assert said[2] == "claude.ai shows there: the check passed. Closing that window..."
        assert said[3] == "Opening the 2 window again."
        assert len(said) == 4
        assert len(plain) == 1 and plain[0].endswith(pma.CHECK_SUFFIX)
        assert window.page.evaluate("location.pathname", await_promise=False) == "/"
    finally:
        window.close()


@real_browser
@pytest.mark.xdist_group("real-browser")
def test_an_import_the_check_interrupts_is_carried_on_in_the_same_project(mocks, tmp_path):
    """The site's check takes the window in the middle of the import; the import carries on where it was."""
    source_site = mocks("--small")
    dest_site = mocks("--challenge", "6", "--challenge-after-writes", "1")
    root = tmp_path / "cswap"
    said: list[str] = []
    src = _window(pma.Account("source", "2", "", MOCK_ORG), root, source_site.site, said)
    try:
        export = pma.run_export(src, source_site.site, "chan_01BEETHOVENBEETHOVEN0000", tmp_path / "exports", said.append)
    finally:
        src.close()
    assert export.complete
    destination = pma.Account("destination", "1", "", MOCK_ORG)
    _window(destination, root, dest_site.site, said).close()
    said.clear()

    url = pma._in_window(
        destination, "1", root, dest_site.site, BROWSER, "import",
        lambda window, carry: pma.run_import(window, dest_site.site, export, "", said.append, into=carry),
        say=said.append, headless=True, extra_args=BROWSER_ARGS, label_seconds=1,
    )
    made = dest_site.made()
    assert [c["name"] for c in made["channels"]] == ["beethoven (imported)"]
    assert url == f"{dest_site.site}/code/project/{made['channels'][0]['id']}"
    # Every file of the export, the saved conversations and their README: nothing left out.
    manifest = json.loads((export.path / pm.MANIFEST_NAME).read_text(encoding="utf-8"))
    assert len(made["channels"][0]["files"]) == len(manifest["files"]) + len(manifest["history"]) + 1
    stop = next(i for i, line in enumerate(said) if line.startswith("Claude.ai's security check took that window over in the middle of the import"))
    assert said[stop + 1].startswith("That check does not pass in a driven window.")
    assert any(line.startswith(f"Carrying on with the import in {url}: what it holds already is left alone.") for line in said[stop:])
    assert any(line.strip().startswith("Done") and "the import into" in line for line in said[stop:])


@real_browser
@pytest.mark.xdist_group("real-browser")
def test_a_profile_signed_in_as_someone_else_is_signed_out_first(mocks, tmp_path):
    """The window for an account never opens inside another account's session."""
    site = mocks("--signed-out")
    root = tmp_path / "cswap"
    # The mock does not name its sign-ins (its /login route aside), so this
    # account is known by its organization, as one cswap holds is.
    account = pma.Account("source", "2", "src@example.com", MOCK_ORG)
    profile = account.profile_dir(root)

    # The profile holds somebody else's sign-in: the person signed in to it
    # as the wrong account on an earlier run.
    stamp = pma.store_stamp(profile)
    seed = cdp.launch_plain(BROWSER, profile, site.site + "/login?as=other@example.com", headless=True, extra_args=BROWSER_ARGS)
    _person_signed_in(site, seed)
    assert _person_closes(seed, profile, stamp) == 0
    (profile / "seeded").write_text("")

    def looking_on(process):
        assert not (profile / "seeded").exists(), "the other account's session was still there"
        assert not (profile / cdp.PORT_FILE).exists()
        stamp = pma.store_stamp(profile)
        _person_signed_in(site, process, logins_before=1)
        assert _person_closes(process, profile, stamp) == 0

    said: list[str] = []
    window = _window(account, root, site.site, said, wait=looking_on)
    try:
        assert said[0] == "The src@example.com window was signed in as other@example.com. Signed it out."
        assert said[1].startswith("A browser window just opened for src@example.com (the SOURCE account);")
        assert said[-1] == "Signed in as src@example.com (source)."
        assert window.signed_in_as == "src@example.com"
        assert site.made()["logins"] == 2
    finally:
        window.close()


@real_browser
@pytest.mark.xdist_group("real-browser")
def test_signing_in_as_the_wrong_account_is_refused(mocks, tmp_path):
    site = mocks("--signed-out", "--login-as", "other@example.com")
    root = tmp_path / "cswap"
    account = pma.Account("source", "2", "src@example.com")
    with pytest.raises(ValidationError, match="You signed in as other@example.com, but that window was for src@example.com"):
        _window(account, root, site.site, wait=_person(site, account.profile_dir(root)))
    assert not account.profile_dir(root).exists()


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
        str(int(SIGN_IN_WAIT)),
        "--label-seconds",
        "1",
    ]
    code, out, err = _run(argv, capsys)
    assert code == 0, out + err
    assert "Moved: the new project is at " + site.site in out
    assert [c["name"] for c in site.made()["channels"]] == ["Moved by cswap"]

    code, out, err = _run(
        ["auto", "--name", "Moved again", "--site", site.site, "--headless", "--browser", BROWSER,
         *[f"--browser-arg={a}" for a in BROWSER_ARGS], "--label-seconds", "1",
         "--login-timeout", str(int(SIGN_IN_WAIT))],
        capsys,
    )
    assert code == 0, out + err
    assert sorted(c["name"] for c in site.made()["channels"]) == ["Moved again", "Moved by cswap"]
    # The second export did not land in the first one's folder.
    assert (pm.default_exports_folder() / "beethoven (2)" / pm.MANIFEST_NAME).is_file()


@real_browser
@pytest.mark.xdist_group("real-browser")
def test_the_command_rides_out_the_check_in_the_middle_of_the_import(mocks, temp_home, capsys):
    site = mocks("--challenge", "6", "--challenge-after-writes", "1")
    code, out, err = _run(
        ["auto", "beethoven", "--from", "s@example.com", "--to", "d@example.com", "--site", site.site,
         "--headless", "--browser", BROWSER, *[f"--browser-arg={a}" for a in BROWSER_ARGS], "--label-seconds", "1",
         "--login-timeout", str(int(SIGN_IN_WAIT))],
        capsys,
    )
    assert code == 0, out + err
    made = site.made()
    assert [c["name"] for c in made["channels"]] == ["beethoven (imported)"]
    assert len(made["channels"][0]["files"]) == 38
    assert "security check took that window over in the middle of the import" in out
    assert "Carrying on with the import in" in out
    assert "Moved: the new project is at " + site.site in out
    from claude_swap.paths import get_backup_root

    assert pma.AutoSettings.load(get_backup_root()).into == ""


@real_browser
@pytest.mark.xdist_group("real-browser")
def test_a_name_that_matches_no_project_lists_the_projects(mocks, temp_home, capsys):
    site = mocks()
    code, out, err = _run(
        ["auto", "no such project", "--from", "s@example.com", "--to", "d@example.com", "--site", site.site,
         "--headless", "--browser", BROWSER, *[f"--browser-arg={a}" for a in BROWSER_ARGS], "--label-seconds", "1",
         "--login-timeout", str(int(SIGN_IN_WAIT))],
        capsys,
    )
    assert code == 1
    text = out + err
    assert 'No single project here is called "no such project"' in text
    assert "beethoven" in text
    assert site.made()["channels"] == []
