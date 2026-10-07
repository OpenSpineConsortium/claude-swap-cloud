"""The computer's own file windows, as the bridge opens them.

Nothing here opens a window: the programs that would are found through
``shutil.which`` and ``os.path.isfile`` under monkeypatch, started through
a fake ``popen`` that records what it was given, and what they said is
read back through ``outcome`` from bytes the test wrote.
"""

from __future__ import annotations

import base64
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from claude_swap import file_dialogs
from claude_swap.file_dialogs import DialogError, DialogSpec

SAVE = DialogSpec(kind="save", title="Save the export of Demo as", directory="/home/greg/exports", filename="Demo.tar",
                  patterns=["*.tar"], owner="123456")
OPEN = DialogSpec(kind="open", title="Open the export to import", directory="/home/greg/exports")

# What the environment carries, by the spec's field, as the scripts read it.
_ENV_FIELDS = {
    "CSWAP_DIALOG_KIND": "kind",
    "CSWAP_DIALOG_TITLE": "title",
    "CSWAP_DIALOG_DIR": "directory",
    "CSWAP_DIALOG_NAME": "filename",
    "CSWAP_DIALOG_FILTER_LABEL": "filter_label",
    "CSWAP_DIALOG_EXT": "extension",
    "CSWAP_DIALOG_OWNER": "owner",
}


def _shipped_powershell() -> str:
    return os.path.join(os.environ.get("SystemRoot") or r"C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")


def _which(found: dict[str, str]):
    """A ``shutil.which`` that knows only ``found``."""
    return lambda name, *args, **kwargs: found.get(name)


def _decoded_command(argv: list[str]) -> str:
    """The PowerShell script ``argv`` carries after ``-EncodedCommand``: base64 of UTF-16LE."""
    encoded = argv[argv.index("-EncodedCommand") + 1]
    return base64.b64decode(encoded).decode("utf-16-le")


def _spec_text(spec: DialogSpec) -> list[str]:
    """What of the spec must never be on a command line."""
    return [value for value in (spec.title, spec.directory, spec.filename, spec.owner) if value]


# ---------------------------------------------------------------------------
# The environment
# ---------------------------------------------------------------------------


class TestEnvironment:
    def test_every_field_of_the_spec_travels_in_the_environment(self):
        env = file_dialogs.environment(SAVE, {"PATH": "/usr/bin", "HOME": "/home/greg"})
        assert {key: env[key] for key in _ENV_FIELDS} == {key: getattr(SAVE, field) for key, field in _ENV_FIELDS.items()}
        assert env["CSWAP_DIALOG_FILTER"] == "*.tar"
        assert env["PATH"] == "/usr/bin" and env["HOME"] == "/home/greg", "the computer's own environment stays"
        assert set(env) == {"PATH", "HOME", "CSWAP_DIALOG_FILTER", *_ENV_FIELDS}
        several = file_dialogs.environment(OPEN, {})
        assert several["CSWAP_DIALOG_FILTER"] == "*.tar export.json" and several["CSWAP_DIALOG_NAME"] == ""
        assert several["CSWAP_DIALOG_OWNER"] == "" and several["CSWAP_DIALOG_FILTER_LABEL"] == "Project export"

    def test_the_computers_environment_is_the_base_when_none_is_given(self, monkeypatch):
        monkeypatch.setenv("CSWAP_TEST_MARKER", "here")
        env = file_dialogs.environment(OPEN)
        assert env["CSWAP_TEST_MARKER"] == "here" and env["CSWAP_DIALOG_KIND"] == "open"
        assert "CSWAP_DIALOG_KIND" not in os.environ, "the computer's own environment is not changed"

    def test_the_kind_is_save_or_open_and_nothing_else(self):
        assert file_dialogs.environment(DialogSpec(kind="save", title="t"), {})["CSWAP_DIALOG_KIND"] == "save"
        assert file_dialogs.environment(DialogSpec(kind="open", title="t"), {})["CSWAP_DIALOG_KIND"] == "open"
        assert file_dialogs.environment(DialogSpec(kind="sideways", title="t"), {})["CSWAP_DIALOG_KIND"] == "open"


# ---------------------------------------------------------------------------
# The programs that can show a window, per system
# ---------------------------------------------------------------------------


class TestCandidates:
    def test_windows_runs_the_shipped_powershell_with_the_script_encoded_and_nothing_of_the_spec_on_the_line(self, monkeypatch):
        monkeypatch.setenv("SystemRoot", r"C:\Win")
        shipped = _shipped_powershell()
        monkeypatch.setattr(os.path, "isfile", lambda path: path == shipped)
        monkeypatch.setattr(shutil, "which", _which({}))
        found = file_dialogs.candidates(SAVE, platform="win32", python="py")
        assert [name for name, _ in found] == ["powershell", "tkinter"]
        argv = found[0][1]
        assert argv[:5] == [shipped, "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand"] and len(argv) == 6
        assert _decoded_command(argv) == file_dialogs._POWERSHELL_SCRIPT
        for text in _spec_text(SAVE):
            assert not any(text in arg for arg in argv), text
        # The script reads what the window shows from the environment, every variable of it.
        for key in file_dialogs.environment(SAVE, {}):
            assert f"$env:{key}" in file_dialogs._POWERSHELL_SCRIPT, key

    def test_windows_falls_back_to_the_powershell_on_the_path(self, monkeypatch):
        monkeypatch.setattr(os.path, "isfile", lambda path: False)
        monkeypatch.setattr(shutil, "which", _which({"pwsh": r"C:\pwsh\pwsh.exe"}))
        found = file_dialogs.candidates(OPEN, platform="win32", python="py")
        assert [name for name, _ in found] == ["powershell", "tkinter"]
        assert found[0][1][0] == r"C:\pwsh\pwsh.exe" and found[0][1][4] == "-EncodedCommand"
        monkeypatch.setattr(shutil, "which", _which({"powershell": r"C:\ps\powershell.exe", "pwsh": r"C:\pwsh\pwsh.exe"}))
        assert file_dialogs.candidates(OPEN, platform="win32", python="py")[0][1][0] == r"C:\ps\powershell.exe"

    def test_windows_without_powershell_has_only_tkinter(self, monkeypatch):
        monkeypatch.setattr(os.path, "isfile", lambda path: False)
        monkeypatch.setattr(shutil, "which", _which({}))
        assert [name for name, _ in file_dialogs.candidates(OPEN, platform="win32", python="py")] == ["tkinter"]

    def test_mac_runs_osascript_with_the_script_as_its_one_argument(self, monkeypatch):
        monkeypatch.setattr(shutil, "which", _which({"osascript": "/usr/bin/osascript", "zenity": "/usr/bin/zenity"}))
        found = file_dialogs.candidates(SAVE, platform="darwin", python="py")
        assert [name for name, _ in found] == ["osascript", "tkinter"], "zenity is not the Mac's"
        assert found[0][1] == ["/usr/bin/osascript", "-e", file_dialogs._APPLESCRIPT]
        for text in _spec_text(SAVE):
            assert not any(text in arg for arg in found[0][1]), text
        for key in ("CSWAP_DIALOG_KIND", "CSWAP_DIALOG_TITLE", "CSWAP_DIALOG_DIR", "CSWAP_DIALOG_NAME"):
            assert f'system attribute "{key}"' in file_dialogs._APPLESCRIPT

    def test_linux_offers_zenity_then_kdialog_with_the_flags_of_a_save(self, monkeypatch):
        monkeypatch.setattr(shutil, "which", _which({"zenity": "/usr/bin/zenity", "kdialog": "/usr/bin/kdialog", "osascript": "/x"}))
        found = file_dialogs.candidates(SAVE, platform="linux", python="py")
        assert [name for name, _ in found] == ["zenity", "kdialog", "tkinter"]
        assert found[0][1] == [
            "/usr/bin/zenity", "--file-selection", "--title=Save the export of Demo as", "--file-filter=Project export | *.tar",
            "--save", "--confirm-overwrite", "--filename=" + os.path.join("/home/greg/exports", "Demo.tar"),
        ]
        assert found[1][1] == [
            "/usr/bin/kdialog", "--title", "Save the export of Demo as", "--getsavefilename",
            os.path.join("/home/greg/exports", "Demo.tar"), "Project export (*.tar)",
        ]

    def test_linux_offers_zenity_then_kdialog_with_the_flags_of_an_open(self, monkeypatch):
        monkeypatch.setattr(shutil, "which", _which({"zenity": "/usr/bin/zenity", "kdialog": "/usr/bin/kdialog"}))
        found = file_dialogs.candidates(OPEN, platform="linux", python="py")
        zenity, kdialog = found[0][1], found[1][1]
        assert zenity == [
            "/usr/bin/zenity", "--file-selection", "--title=Open the export to import",
            "--file-filter=Project export | *.tar export.json", "--filename=" + os.path.join("/home/greg/exports", ""),
        ]
        assert "--save" not in zenity and "--confirm-overwrite" not in zenity
        assert kdialog == [
            "/usr/bin/kdialog", "--title", "Open the export to import", "--getopenfilename",
            os.path.join("/home/greg/exports", ""), "Project export (*.tar export.json)",
        ]

    def test_zenity_names_no_file_when_the_spec_names_no_folder_or_name(self, monkeypatch):
        monkeypatch.setattr(shutil, "which", _which({"zenity": "/usr/bin/zenity"}))
        bare_save = file_dialogs.candidates(DialogSpec(kind="save", title="t"), platform="linux", python="py")[0][1]
        assert bare_save[-2:] == ["--save", "--confirm-overwrite"] and not any(a.startswith("--filename") for a in bare_save)
        bare_open = file_dialogs.candidates(DialogSpec(kind="open", title="t"), platform="linux", python="py")[0][1]
        assert not any(a.startswith("--filename") for a in bare_open)
        named = file_dialogs.candidates(DialogSpec(kind="save", title="t", filename="x.tar"), platform="linux", python="py")[0][1]
        assert named[-1] == "--filename=x.tar"

    @pytest.mark.parametrize("platform", ["win32", "darwin", "linux", "freebsd14"])
    def test_tkinter_is_last_everywhere_and_runs_isolated(self, monkeypatch, platform):
        monkeypatch.setattr(os.path, "isfile", lambda path: False)
        monkeypatch.setattr(shutil, "which", _which({}))
        found = file_dialogs.candidates(OPEN, platform=platform, python="/opt/py/python3")
        assert found[-1] == ("tkinter", ["/opt/py/python3", "-I", "-c", file_dialogs._TKINTER_SCRIPT])
        for text in _spec_text(OPEN):
            assert not any(text in arg for arg in found[-1][1]), text
        # The script reads the window from the environment; the owner window is Windows' alone.
        for key in file_dialogs.environment(OPEN, {}):
            assert (key in file_dialogs._TKINTER_SCRIPT) == (key != "CSWAP_DIALOG_OWNER"), key
        # The host's own interpreter when none is named; none at all when there is none.
        assert file_dialogs.candidates(OPEN, platform=platform)[-1][1][0] == sys.executable
        monkeypatch.setattr(sys, "executable", "")
        assert file_dialogs.candidates(OPEN, platform=platform) == []


# ---------------------------------------------------------------------------
# Starting the program
# ---------------------------------------------------------------------------


class _Popen:
    """A ``subprocess.Popen`` that records what it was given; ``refuse`` says which calls fail."""

    def __init__(self, refuse=lambda argv, kwargs: False):
        self.calls: list[tuple[list[str], dict]] = []
        self.refuse = refuse
        self.pid = 4242

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        if self.refuse(argv, kwargs):
            raise OSError(2, "no such file", argv[0])
        self.pid += 1
        return type("Proc", (), {"pid": self.pid})()


def _linux_tools(monkeypatch):
    monkeypatch.setattr(shutil, "which", _which({"zenity": "/usr/bin/zenity", "kdialog": "/usr/bin/kdialog"}))


def _windows_tools(monkeypatch):
    monkeypatch.setenv("SystemRoot", r"C:\Win")
    shipped = _shipped_powershell()
    monkeypatch.setattr(os.path, "isfile", lambda path: path == shipped)
    monkeypatch.setattr(shutil, "which", _which({}))
    return shipped


class TestStart:
    def test_the_program_gets_no_stdin_the_two_files_and_the_environment(self, monkeypatch, tmp_path):
        _linux_tools(monkeypatch)
        popen = _Popen()
        out, err = tmp_path / "d.out", tmp_path / "d.err"
        name, pid, handle = file_dialogs.start(SAVE, out_path=out, err_path=err, platform="linux", popen=popen, python="py", environ={"HOME": "/h"})
        assert (name, pid) == ("zenity", 4243) and handle.pid == 4243
        ((argv, kwargs),) = popen.calls
        assert argv[0] == "/usr/bin/zenity"
        assert kwargs["stdin"] is subprocess.DEVNULL and kwargs["close_fds"] is True and kwargs["start_new_session"] is True
        assert kwargs["stdout"].name == str(out) and kwargs["stderr"].name == str(err)
        assert kwargs["stdout"].closed and kwargs["stderr"].closed, "the bridge keeps no handle on the program's files"
        assert out.exists() and err.exists()
        assert kwargs["env"] == file_dialogs.environment(SAVE, {"HOME": "/h"})
        assert "creationflags" not in kwargs

    def test_windows_hides_the_window_and_leaves_the_job_when_it_can(self, monkeypatch, tmp_path):
        shipped = _windows_tools(monkeypatch)
        popen = _Popen()
        name, pid, _ = file_dialogs.start(SAVE, out_path=tmp_path / "o", err_path=tmp_path / "e", platform="win32", popen=popen, python="py", environ={})
        assert name == "powershell" and pid == 4243
        ((argv, kwargs),) = popen.calls
        assert argv[0] == shipped
        assert kwargs["creationflags"] == file_dialogs._CREATE_NO_WINDOW | file_dialogs._CREATE_BREAKAWAY_FROM_JOB
        assert kwargs["stdin"] is subprocess.DEVNULL and kwargs["close_fds"] is True
        assert kwargs["stdout"].name == str(tmp_path / "o") and kwargs["stderr"].name == str(tmp_path / "e")
        assert "start_new_session" not in kwargs
        assert kwargs["env"]["CSWAP_DIALOG_OWNER"] == "123456"

    def test_windows_starts_inside_the_job_when_it_cannot_leave_it(self, monkeypatch, tmp_path):
        _windows_tools(monkeypatch)
        popen = _Popen(refuse=lambda argv, kwargs: bool(kwargs["creationflags"] & file_dialogs._CREATE_BREAKAWAY_FROM_JOB))
        name, pid, _ = file_dialogs.start(SAVE, out_path=tmp_path / "o", err_path=tmp_path / "e", platform="win32", popen=popen, python="py", environ={})
        assert name == "powershell" and pid == 4243
        assert [kwargs["creationflags"] for _, kwargs in popen.calls] == [
            file_dialogs._CREATE_NO_WINDOW | file_dialogs._CREATE_BREAKAWAY_FROM_JOB, file_dialogs._CREATE_NO_WINDOW,
        ]
        assert popen.calls[0][0] == popen.calls[1][0], "the same program, once more"

    def test_the_first_program_that_starts_wins_and_the_next_is_tried_when_it_cannot(self, monkeypatch, tmp_path):
        _linux_tools(monkeypatch)
        popen = _Popen(refuse=lambda argv, kwargs: argv[0].endswith("zenity"))
        name, pid, _ = file_dialogs.start(OPEN, out_path=tmp_path / "o", err_path=tmp_path / "e", platform="linux", popen=popen, python="py", environ={})
        assert name == "kdialog" and pid == 4243
        assert [argv[0] for argv, _ in popen.calls] == ["/usr/bin/zenity", "/usr/bin/kdialog"]
        # Windows: a PowerShell that cannot start either way gives way to tkinter.
        _windows_tools(monkeypatch)
        popen = _Popen(refuse=lambda argv, kwargs: argv[0].endswith("powershell.exe"))
        name, _, _ = file_dialogs.start(OPEN, out_path=tmp_path / "o", err_path=tmp_path / "e", platform="win32", popen=popen, python="py", environ={})
        assert name == "tkinter"
        assert [argv[0] for argv, _ in popen.calls] == [_shipped_powershell(), _shipped_powershell(), "py"]

    def test_no_program_that_starts_is_a_dialog_error_that_says_why(self, monkeypatch, tmp_path):
        _linux_tools(monkeypatch)
        popen = _Popen(refuse=lambda argv, kwargs: True)
        with pytest.raises(DialogError) as e:
            file_dialogs.start(OPEN, out_path=tmp_path / "o", err_path=tmp_path / "e", platform="linux", popen=popen, python="py", environ={})
        assert str(e.value).startswith("no file window could be opened on this computer (")
        assert "zenity: " in str(e.value) and "kdialog: " in str(e.value) and "tkinter: " in str(e.value)
        assert len(popen.calls) == 3
        # No program found at all.
        monkeypatch.setattr(shutil, "which", _which({}))
        monkeypatch.setattr(sys, "executable", "")
        never = _Popen()
        with pytest.raises(DialogError) as e:
            file_dialogs.start(OPEN, out_path=tmp_path / "o", err_path=tmp_path / "e", platform="linux", popen=never, environ={})
        assert str(e.value) == "no file window could be opened on this computer (no PowerShell, osascript, zenity, kdialog or tkinter found)"
        assert never.calls == []


# ---------------------------------------------------------------------------
# What the window said
# ---------------------------------------------------------------------------


class TestOutcome:
    @pytest.mark.parametrize(
        ("out", "err", "code", "expected"),
        [
            (b"/home/greg/exports/Demo.tar", b"", 0, ("chosen", "/home/greg/exports/Demo.tar")),
            (b"\xef\xbb\xbfC:\\Users\\greg\\Demo.tar\r\n", b"", 0, ("chosen", "C:\\Users\\greg\\Demo.tar")),
            (b"/home/greg/exports/Demo.tar\n", b"(zenity:4242): Gtk-WARNING **: 12:00:00.000: some error\n", 0, ("chosen", "/home/greg/exports/Demo.tar")),
            ("/home/greg/\u00e9t\u00e9/Demo.tar\n".encode("utf-8"), b"", 0, ("chosen", "/home/greg/\u00e9t\u00e9/Demo.tar")),
            (b"", b"", 0, ("cancelled", "")),
            (b"", b"", 1, ("cancelled", "")),
            (b"\n", b"", 0, ("cancelled", "")),
            (b"", b"", None, ("cancelled", "")),
            (b"", b"4242:4243: execution error: User canceled. (-128)\n", 1, ("cancelled", "")),
            (b"", b"(zenity:4242): Gtk-WARNING **: 12:00:00.000: Unable to locate theme engine in module_path: \"pixmap\"\n", 1, ("cancelled", "")),
            (b"", b"Add-Type : Cannot add type.\nAt line:4 char:1\n", 3, ("error", "the file window failed: At line:4 char:1")),
            (b"", b"", 3, ("error", "the file window failed: it left with code 3")),
            (b"", b"Traceback (most recent call last):\n  File \"<string>\", line 4\nModuleNotFoundError: No module named 'tkinter'\n", 1,
             ("error", "the file window failed: ModuleNotFoundError: No module named 'tkinter'")),
            (b"", b"", 255, ("error", "the file window failed: it left with code 255")),
            (b"", b"kdialog: command not recognized\n", 2, ("error", "the file window failed: kdialog: command not recognized")),
        ],
        ids=["path", "bom-and-crlf", "path-with-a-warning", "utf8-path", "empty-0", "empty-1", "newline-only", "no-code",
             "osascript-cancel", "gtk-warning-1", "complaint-3", "bare-3", "traceback-1", "bare-255", "complaint-2"],
    )
    def test_what_the_window_said(self, out, err, code, expected):
        assert file_dialogs.outcome(out, err, code) == expected

    def test_a_long_complaint_is_cut_to_its_last_line_and_three_hundred_characters(self):
        verdict, why = file_dialogs.outcome(b"", b"first line\n" + b"x" * 1000, 3)
        assert verdict == "error" and why == "the file window failed: " + "x" * 300

    def test_the_last_line_of_the_output_is_the_path(self):
        # tkinter may print a line of its own before the path on some systems.
        assert file_dialogs.outcome(b"some note\n/home/greg/Demo.tar\n", b"", 0) == ("chosen", "/home/greg/Demo.tar")
