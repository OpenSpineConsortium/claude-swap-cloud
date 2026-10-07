"""Tests for `cswap project-move` (claude_swap.project_move + the CLI stage).

The browser scripts themselves are exercised by tests/js/ (run from
tests/test_project_move_scripts.py when Node is installed); here they are
only held to what the Python side relies on.
"""

from __future__ import annotations

import io
import itertools
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
from importlib import resources
from pathlib import Path
from unittest.mock import patch

import pytest

from claude_swap import cli
from claude_swap import project_move as pm
from claude_swap.exceptions import ValidationError


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _run(argv: list[str], capsys) -> tuple[int, str, str]:
    """Run `cswap project-move <argv>` with the browser and clipboard stubbed out."""
    with patch("os.geteuid", return_value=1000, create=True), \
         patch.object(sys, "argv", ["cswap", "project-move", *argv]), \
         patch.object(pm, "open_url", return_value=True), \
         patch.object(pm, "copy_to_clipboard", return_value=None):
        code = 0
        try:
            cli.main()
        except SystemExit as e:
            code = e.code or 0
    captured = capsys.readouterr()
    return code, captured.out, captured.err


class _FakeResponse:
    def __init__(self, status: int, payload: dict | None):
        self.status = status
        self._body = json.dumps(payload or {}).encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _fake_github(routes: dict[str, tuple[int, dict | None]]):
    """A urlopen stand-in: ``routes`` maps API paths to (status, json body)."""
    calls: list[tuple[str, dict]] = []

    def urlopen(req, timeout=None):
        path = req.full_url.removeprefix("https://api.github.com")
        calls.append((path, dict(req.header_items())))
        status, payload = routes.get(path, (404, None))
        if status != 200:
            raise urllib.error.HTTPError(req.full_url, status, "nope", {}, io.BytesIO(b""))
        return _FakeResponse(status, payload)

    urlopen.calls = calls  # type: ignore[attr-defined]
    return urlopen


REPO = "owner/name"
_REPO_PRIVATE = {"private": True, "default_branch": "main"}
_REPO_PUBLIC = {"private": False, "default_branch": "main"}


def _state_root(temp_home: Path) -> Path:
    from claude_swap.paths import get_backup_root

    return get_backup_root()


def _exports(temp_home: Path) -> Path:
    """Where exports go by default, under the test's home."""
    return temp_home / pm.DEFAULT_EXPORTS_DIRNAME


# What _make_export writes, by kind: the project's own files, then the saved
# conversations. The totals are what `check` is expected to count.
_CODE_FILES = {"Files/notes.md": b"# notes\n", "Files/data/table.csv": b"a,b\n1,2\n"}
_CODE_HISTORY = {"Timeline.md": b"timeline\n", "Threads/001 Kick-off.md": b"thread\n"}
_CODE_BYTES = 32
_STANDARD_FILES = {"Files/menu.pdf": b"%PDF-1.4 menu", "Files/notes.md": b"Salt the water.\n"}
_STANDARD_HISTORY = {"Chats/Pasta/Pasta.md": b"chat\n"}
_STANDARD_MEMORY = b"Likes garlic.\n"
_STANDARD_BYTES = 48


def _make_export(
    parent: Path,
    name: str = "Demo",
    *,
    kind: str = "code",
    age: float = 0.0,
    problems: tuple[str, ...] = (),
) -> Path:
    """Write a small finished export, laid out as project-export.js lays one out.

    ``age`` is how many seconds ago it finished, which is the age of its
    export.json. A Claude Code project records each file's size; a regular
    project does not, and has a memory.
    """
    root = parent / name
    if kind == "code":
        files, history = _CODE_FILES, _CODE_HISTORY
        on_disk = {**files, **history, "Channel Info.md": b"About the project.\n"}
        manifest = {
            "files": [
                {"path": path, "name": path.removeprefix("Files/"), "type": "project_file", "bytes": len(data)}
                for path, data in files.items()
            ],
            "history": [{"path": path, "title": Path(path).stem, "type": "thread"} for path in history],
            "problems": list(problems),
        }
    else:
        files, history = _STANDARD_FILES, _STANDARD_HISTORY
        on_disk = {
            **files,
            **history,
            "Project Instructions.md": b"Be a patient cook.\n",
            "Project Memory.md": _STANDARD_MEMORY,
        }
        manifest = {
            "files": [{"path": path, "name": path.removeprefix("Files/"), "type": "file"} for path in files],
            "history": [{"path": path, "title": "Pasta", "type": "chat"} for path in history],
            "memory": {"path": "Project Memory.md"},
        }
    for relative, data in on_disk.items():
        target = root.joinpath(*relative.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    _write_manifest(
        root,
        {"format": pm.MANIFEST_FORMAT, "version": pm.MANIFEST_VERSION, "kind": kind, "name": name, **manifest},
        age=age,
    )
    return root


def _write_manifest(root: Path, payload: object, *, age: float = 0.0) -> None:
    root.mkdir(parents=True, exist_ok=True)
    path = root / pm.MANIFEST_NAME
    path.write_text(payload if isinstance(payload, str) else json.dumps(payload), encoding="utf-8")
    if age:
        when = time.time() - age
        os.utime(path, (when, when))


def _manifest(root: Path) -> dict:
    return json.loads((root / pm.MANIFEST_NAME).read_text(encoding="utf-8"))


# A path that, with the export's folder in front, is longer than the 100
# bytes a plain tar header holds a name in: the archive then needs a GNU
# long-name entry for it, as a real export often does. (Kept short of that
# by itself, so that the file under a test's temp folder fits in Windows'
# 260-character paths.)
_LONG_PATH = "Files/" + "a long name " * 6 + "that ends here.md"
_LONG_DATA = b"long\n"
_ARCHIVE_BYTES = _CODE_BYTES + len(_LONG_DATA)


def _pack(root: Path, archive: Path) -> Path:
    """Pack the export folder ``root`` into ``archive`` as the browser's "Save as .tar instead" does.

    Files only, no folder entries, each under the export folder's name, and
    GNU long names where a path is over 100 bytes.
    """
    with tarfile.open(archive, "w", format=tarfile.GNU_FORMAT) as tar:
        for file in sorted(p for p in root.rglob("*") if p.is_file()):
            tar.add(file, arcname=f"{root.name}/{file.relative_to(root).as_posix()}")
    return archive


def _make_archive(
    parent: Path,
    name: str = "beethoven",
    *,
    kind: str = "code",
    age: float = 0.0,
    before=None,
) -> Path:
    """Write an export with :func:`_make_export` and pack it into ``parent/<name>.tar``.

    One file more than :func:`_make_export` writes, with a path that needs a
    GNU long name. ``before`` may change the folder before it is packed;
    ``age`` is how many seconds ago the .tar was saved.
    """
    staging = parent / "unpacked"
    root = _make_export(staging, name, kind=kind)
    root.joinpath(*_LONG_PATH.split("/")).write_bytes(_LONG_DATA)
    manifest = _manifest(root)
    row = {"path": _LONG_PATH, "name": _LONG_PATH.removeprefix("Files/"), "type": "project_file"}
    if kind == "code":
        row["bytes"] = len(_LONG_DATA)
    manifest["files"].append(row)
    _write_manifest(root, manifest)
    if before is not None:
        before(root)
    archive = _pack(root, parent / f"{name}{pm.ARCHIVE_SUFFIX}")
    shutil.rmtree(staging)
    if age:
        when = time.time() - age
        os.utime(archive, (when, when))
    return archive


def _cut_short(archive: Path) -> Path:
    """Cut ``archive`` off right after its last entry, as a download that stopped early is.

    The browser's .tar ends in two zero blocks; tarfile's has zero padding
    after them as well. Both go, and the last entry keeps its own padding.
    """
    data = archive.read_bytes().rstrip(b"\0")
    archive.write_bytes(data + bytes(-len(data) % 512))
    return archive


# ---------------------------------------------------------------------------
# normalize_repo / state
# ---------------------------------------------------------------------------


class TestNormalizeRepo:
    @pytest.mark.parametrize(
        "spec",
        [
            "owner/name",
            "https://github.com/owner/name",
            "https://github.com/owner/name.git",
            "https://github.com/owner/name/",
            "git@github.com:owner/name.git",
            "  owner/name  ",
        ],
    )
    def test_accepts_github_spellings(self, spec):
        assert pm.normalize_repo(spec) == "owner/name"

    @pytest.mark.parametrize("spec", ["name", "owner/", "/name", "owner/name/extra", "", "owner name"])
    def test_rejects_other_shapes(self, spec):
        with pytest.raises(ValidationError):
            pm.normalize_repo(spec)

    @pytest.mark.parametrize("spec", ["OWNER/NAME", " OWNER/NAME ", "https://github.com/OWNER/NAME.git"])
    def test_rejects_the_step_list_placeholder(self, spec):
        # The step list prints `export OWNER/NAME`; pasting it back into a
        # shell must not run the stage with the placeholder.
        with pytest.raises(ValidationError, match="placeholder"):
            pm.normalize_repo(spec)

    def test_a_projects_name_is_pointed_at_the_move_that_needs_no_name(self, tmp_path, monkeypatch):
        # The likely mistake is the project's name. The error still says what
        # a repository looks like, and that the browser scripts take no name.
        monkeypatch.chdir(tmp_path)
        with pytest.raises(ValidationError) as e:
            pm.normalize_repo("beethoven")
        message = str(e.value)
        assert message.startswith("Not a GitHub repository: 'beethoven'.")
        assert "not the project's name" in message
        assert "browser scripts, give no name" in message
        assert "--folder" not in message

    @pytest.mark.parametrize("spec", ["~/exports", "./exports", "/srv/exports", "C:\\Users\\me\\exports", "D:/exports"])
    def test_a_path_is_pointed_at_the_folder_option(self, spec):
        with pytest.raises(ValidationError, match="--folder"):
            pm.normalize_repo(spec)

    def test_an_existing_folder_is_pointed_at_the_folder_option(self, tmp_path, monkeypatch):
        (tmp_path / "exports").mkdir()
        monkeypatch.chdir(tmp_path)
        with pytest.raises(ValidationError, match="--folder"):
            pm.normalize_repo("exports")

    def test_a_plain_typo_gets_no_folder_hint(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        with pytest.raises(ValidationError) as e:
            pm.normalize_repo("not-a-repo")
        assert "--folder" not in str(e.value)


class TestMoveState:
    def test_round_trip(self, tmp_path):
        state = pm.MoveState(repo=REPO, branch="b", exported_at="t1")
        state.save(tmp_path)
        loaded = pm.MoveState.load(tmp_path)
        assert (loaded.repo, loaded.branch, loaded.exported_at) == (REPO, "b", "t1")
        assert loaded.imported_at == ""

    def test_round_trip_of_a_script_move(self, tmp_path):
        state = pm.MoveState(
            carrier=pm.CARRIER_FOLDER,
            folder="/exports",
            exported_at="t1",
            export_seen_at="t2",
            export_path="/exports/Demo",
        )
        state.save(tmp_path)
        loaded = pm.MoveState.load(tmp_path)
        assert loaded.carrier == pm.CARRIER_FOLDER
        assert (loaded.folder, loaded.export_seen_at, loaded.export_path) == ("/exports", "t2", "/exports/Demo")
        assert loaded.branch == pm.DEFAULT_BRANCH

    def test_missing_or_corrupt_file_is_fresh_state(self, tmp_path):
        assert pm.MoveState.load(tmp_path).repo == ""
        (tmp_path / pm.STATE_FILE).write_text("{not json", encoding="utf-8")
        state = pm.MoveState.load(tmp_path)
        assert state.repo == ""
        assert state.branch == pm.DEFAULT_BRANCH

    def test_placeholder_saved_by_an_older_version_is_dropped(self, tmp_path):
        pm.MoveState(repo="OWNER/NAME", exported_at="t", branch="other").save(tmp_path)
        state = pm.MoveState.load(tmp_path)
        assert state.repo == ""
        assert state.exported_at == ""
        assert state.branch == pm.DEFAULT_BRANCH

    def test_a_state_file_from_before_the_scripts_still_loads(self, tmp_path):
        # Written by a cswap that only knew the prompts: no carrier, no folder.
        old = {"repo": REPO, "branch": "b", "exported_at": "t1", "imported_at": "", "branch_seen_at": "t2"}
        (tmp_path / pm.STATE_FILE).write_text(json.dumps(old), encoding="utf-8")
        state = pm.MoveState.load(tmp_path)
        assert (state.repo, state.branch, state.branch_seen_at) == (REPO, "b", "t2")
        assert state.carrier == ""
        assert pm.effective_carrier(state) == pm.CARRIER_BRANCH

    def test_unusable_values_fall_back_to_defaults(self, tmp_path):
        odd = {"carrier": "pigeon", "folder": 5, "repo": ["x"], "branch": "", "exported_at": None}
        (tmp_path / pm.STATE_FILE).write_text(json.dumps(odd), encoding="utf-8")
        state = pm.MoveState.load(tmp_path)
        assert (state.carrier, state.folder, state.repo, state.exported_at) == ("", "", "", "")
        assert state.branch == pm.DEFAULT_BRANCH
        (tmp_path / pm.STATE_FILE).write_text("[1, 2]", encoding="utf-8")
        assert pm.MoveState.load(tmp_path).folder == ""

    def test_resolve_repo_prefers_argument_then_memory(self):
        state = pm.MoveState(repo="remembered/one")
        assert pm.resolve_repo(state, "https://github.com/given/two") == "given/two"
        assert pm.resolve_repo(state, None) == "remembered/one"
        with pytest.raises(ValidationError, match="No repository"):
            pm.resolve_repo(pm.MoveState(), None)

    def test_resolve_folder_prefers_argument_then_memory_then_the_default(self, temp_home, tmp_path):
        state = pm.MoveState(folder=str(tmp_path / "remembered"))
        assert pm.resolve_folder(state, str(tmp_path / "given")) == tmp_path / "given"
        assert pm.resolve_folder(state, None) == tmp_path / "remembered"
        assert pm.resolve_folder(state, "   ") == tmp_path / "remembered"
        assert pm.resolve_folder(pm.MoveState(), None) == temp_home / pm.DEFAULT_EXPORTS_DIRNAME

    def test_resolve_folder_makes_the_argument_absolute(self, temp_home, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        assert pm.resolve_folder(pm.MoveState(), "exports") == Path(os.path.abspath("exports"))
        assert pm.resolve_folder(pm.MoveState(), "~/somewhere") == temp_home / "somewhere"

    def test_epoch_reads_what_now_iso_writes(self):
        now = time.time()
        assert abs(pm._epoch(pm._now_iso()) - now) < 5
        assert pm._epoch("") == 0.0
        assert pm._epoch("yesterday") == 0.0


# ---------------------------------------------------------------------------
# which carrier a stage uses
# ---------------------------------------------------------------------------


class TestCarrier:
    def test_effective_carrier(self):
        assert pm.effective_carrier(pm.MoveState()) == pm.CARRIER_FOLDER
        assert pm.effective_carrier(pm.MoveState(repo=REPO)) == pm.CARRIER_BRANCH
        assert pm.effective_carrier(pm.MoveState(repo=REPO, carrier=pm.CARRIER_FOLDER)) == pm.CARRIER_FOLDER
        assert pm.effective_carrier(pm.MoveState(carrier=pm.CARRIER_BRANCH)) == pm.CARRIER_BRANCH

    @pytest.mark.parametrize("stage", ["export", "check", "import", "steps"])
    def test_a_repository_means_the_prompts_and_a_folder_the_scripts(self, stage):
        by_script = pm.MoveState(carrier=pm.CARRIER_FOLDER)
        by_prompt = pm.MoveState(carrier=pm.CARRIER_BRANCH, repo=REPO)
        assert pm.resolve_carrier(by_script, stage, REPO, None) == pm.CARRIER_BRANCH
        assert pm.resolve_carrier(by_prompt, stage, None, "/exports") == pm.CARRIER_FOLDER
        assert pm.resolve_carrier(by_script, stage, branch_options=True) == pm.CARRIER_BRANCH

    def test_export_alone_begins_a_move_by_script(self):
        assert pm.resolve_carrier(pm.MoveState(), "export") == pm.CARRIER_FOLDER
        # Even right after a move by prompt: what is typed decides, not what was done last.
        by_prompt = pm.MoveState(carrier=pm.CARRIER_BRANCH, repo=REPO, exported_at="t")
        assert pm.resolve_carrier(by_prompt, "export") == pm.CARRIER_FOLDER

    @pytest.mark.parametrize("stage", ["check", "import", "steps"])
    def test_the_other_stages_carry_on_with_the_move_in_hand(self, stage):
        assert pm.resolve_carrier(pm.MoveState(), stage) == pm.CARRIER_FOLDER
        assert pm.resolve_carrier(pm.MoveState(carrier=pm.CARRIER_FOLDER, repo=REPO), stage) == pm.CARRIER_FOLDER
        assert pm.resolve_carrier(pm.MoveState(carrier=pm.CARRIER_BRANCH, repo=REPO), stage) == pm.CARRIER_BRANCH
        assert pm.resolve_carrier(pm.MoveState(repo=REPO), stage) == pm.CARRIER_BRANCH

    def test_both_at_once_is_refused(self):
        with pytest.raises(ValidationError, match="one or the other"):
            pm.resolve_carrier(pm.MoveState(), "export", REPO, "/exports")
        with pytest.raises(ValidationError, match="one or the other"):
            pm.resolve_carrier(pm.MoveState(), "check", None, "/exports", branch_options=True)

    def test_a_folder_path_the_shell_split_at_a_space_is_named_as_such(self):
        # greg typed --folder C:\Users\greg\Desktop\beethoven (3) without
        # quotes: the rest of the path arrived as the "repository".
        with pytest.raises(ValidationError) as e:
            pm.resolve_carrier(pm.MoveState(), "import", "(3)", "C:\\Users\\greg\\Desktop\\beethoven")
        assert str(e.value) == (
            'The folder\'s path was split at a space: "(3)" came after --folder C:\\Users\\greg\\Desktop\\beethoven. '
            'Put the whole path in quotes, for example --folder="C:\\Users\\greg\\Desktop\\beethoven (3)"'
        )
        # A repository is owner/name: that stays the other carrier's error.
        with pytest.raises(ValidationError, match="one or the other"):
            pm.resolve_carrier(pm.MoveState(), "import", REPO, "/exports")
        with pytest.raises(ValidationError, match="one or the other"):
            pm.resolve_carrier(pm.MoveState(), "import", "x", "/exports", branch_options=True)

    def test_begin_move_starts_a_move(self):
        state = pm.MoveState()
        with patch.object(pm, "_now_iso", return_value="t1"):
            pm.begin_move(state, pm.CARRIER_FOLDER)
        assert (state.carrier, state.exported_at) == (pm.CARRIER_FOLDER, "t1")

    def test_begin_move_again_mid_move_keeps_it(self):
        state = pm.MoveState(
            carrier=pm.CARRIER_FOLDER, exported_at="t1", export_seen_at="t2", export_path="/exports/Demo"
        )
        with patch.object(pm, "_now_iso", return_value="t9"):
            pm.begin_move(state, pm.CARRIER_FOLDER)
        assert (state.exported_at, state.export_seen_at, state.export_path) == ("t1", "t2", "/exports/Demo")

    @pytest.mark.parametrize(
        "before, carrier, changed",
        [
            # the last move reached its import
            (dict(carrier="folder", exported_at="t1", imported_at="t3"), "folder", False),
            # the last move used the other carrier
            (dict(carrier="branch", repo=REPO, exported_at="t1"), "folder", False),
            (dict(carrier="folder", exported_at="t1"), "branch", False),
            # a state file from before there were two carriers
            (dict(repo=REPO, exported_at="t1"), "folder", False),
            # another repository
            (dict(carrier="branch", repo=REPO, exported_at="t1"), "branch", True),
        ],
    )
    def test_begin_move_starts_over_when_due(self, before, carrier, changed):
        state = pm.MoveState(branch_seen_at="t2", export_seen_at="t2", export_path="/exports/Demo", **before)
        with patch.object(pm, "_now_iso", return_value="t9"):
            pm.begin_move(state, carrier, changed=changed)
        assert state.carrier == carrier
        assert state.exported_at == "t9"
        assert (state.imported_at, state.branch_seen_at, state.export_seen_at, state.export_path) == ("", "", "", "")


# ---------------------------------------------------------------------------
# prompts
# ---------------------------------------------------------------------------


class TestPrompts:
    @pytest.mark.parametrize("stage", ["export", "import"])
    def test_prompt_mentions_repo_branch_and_dir(self, stage):
        text = pm.render_prompt(stage, "acme/widgets", "my-branch")
        assert "acme/widgets" in text
        assert "my-branch" in text
        assert pm.EXPORT_DIR in text
        # Every placeholder got filled.
        assert "{" not in text and "}" not in text
        assert text.endswith("\n")

    def test_export_prompt_is_pushed_without_a_pr_and_skips_secrets(self):
        text = pm.render_prompt("export", REPO)
        assert "do not open a pull request" in text
        assert "secret" in text
        assert "memory/" in text and "files/" in text and "timeline.md" in text

    def test_import_prompt_restores_memory_and_files_and_keeps_history(self):
        text = pm.render_prompt("import", REPO)
        assert "memory" in text
        assert "shared files" in text
        assert pm.HISTORY_DIR in text
        assert f"Do not push anything to {REPO}" in text

    def test_prompts_are_ascii(self):
        # clip.exe on Windows reads the console code page; keep the prompts
        # plain ASCII so a paste never arrives garbled.
        for stage in ("export", "import"):
            pm.render_prompt(stage, REPO).encode("ascii")

    def test_unknown_stage(self):
        with pytest.raises(ValueError):
            pm.render_prompt("delete", REPO)

    def test_write_prompt_file(self, tmp_path):
        path = pm.write_prompt_file(tmp_path, "export", "hello\n")
        assert path == tmp_path / pm.PROMPT_DIR / "export-prompt.md"
        assert path.read_text(encoding="utf-8") == "hello\n"


# ---------------------------------------------------------------------------
# browser scripts
# ---------------------------------------------------------------------------


class TestScripts:
    @pytest.mark.parametrize("stage", ["export", "import"])
    def test_script_ships_with_the_package(self, stage):
        text = pm.script_text(stage)
        # One self-running function and nothing around it: pasting it runs it.
        assert text.startswith("(async () => {\n")
        assert text.endswith("})();\n")
        assert len(text) > 10_000

    @pytest.mark.parametrize("stage", ["export", "import"])
    def test_script_is_ascii(self, stage):
        # A script reaches the browser through the clipboard, and clip.exe on
        # Windows reads the console code page: anything outside ASCII would
        # arrive garbled, in a script that then acts on claude.ai. The files
        # spell every other character as a \uXXXX escape.
        raw = (resources.files("claude_swap") / pm.SCRIPT_DIR / f"project-{stage}.js").read_bytes()
        raw.decode("ascii")
        assert b"\t" not in raw
        pm.script_text(stage).encode("ascii")

    def test_script_text_has_the_same_line_endings_everywhere(self, tmp_path):
        # A checkout on Windows may have \r\n in the working tree.
        (tmp_path / pm.SCRIPT_DIR).mkdir()
        (tmp_path / pm.SCRIPT_DIR / "project-export.js").write_bytes(b"(async () => {\r\n  go();\r\n})();\r\n")
        with patch.object(pm.resources, "files", return_value=tmp_path):
            assert pm.script_text("export") == "(async () => {\n  go();\n})();\n"
        for stage in ("export", "import"):
            assert "\r" not in pm.script_text(stage)

    def test_unknown_stage(self):
        with pytest.raises(ValueError):
            pm.script_text("delete")

    def test_scripts_and_python_agree_on_the_manifest(self):
        export, importer = pm.script_text("export"), pm.script_text("import")
        for text in (export, importer):
            assert f"const MANIFEST = '{pm.MANIFEST_NAME}';" in text
            assert f"'{pm.MANIFEST_FORMAT}'" in text
        assert f"version: {pm.MANIFEST_VERSION}," in export
        # The importer takes exactly the versions read_export takes.
        assert (
            f"manifest.version >= {pm.MANIFEST_VERSION}) || manifest.version >= {pm.MANIFEST_VERSION + 1}"
            in importer
        )

    def test_scripts_and_python_agree_on_what_an_unfinished_export_looks_like(self):
        importer = pm.script_text("import")
        names = ", ".join(f"'{name}'" for name in pm._UNFINISHED_MARKERS)
        assert f"[{names}]" in importer
        export = pm.script_text("export")
        for name in pm._UNFINISHED_MARKERS:
            assert f"'{name}'" in export

    def test_export_script_only_reads(self):
        text = pm.script_text("export")
        for method in ("PUT", "PATCH", "DELETE"):
            assert method not in text
        # Its one POST is how the site lists and opens a project's files.
        assert text.count("method: 'POST'") == 1
        assert "files:list and files:open" in text

    def test_import_script_never_deletes(self):
        text = pm.script_text("import")
        assert "DELETE" not in text
        assert "removeEntry" not in text
        # It opens the chosen folder for reading only.
        assert "showDirectoryPicker({ mode: 'read' })" in text

    def test_write_script_file_is_the_clipboard_text_exactly(self, tmp_path):
        text = pm.script_text("import")
        path = pm.write_script_file(tmp_path, "import", text)
        assert path == tmp_path / pm.PROMPT_DIR / "import-script.js"
        assert path.read_bytes() == text.encode("utf-8")
        # Written again over the old copy, not appended to it.
        assert pm.write_script_file(tmp_path, "import", "x\n").read_bytes() == b"x\n"

    def test_default_exports_folder_is_a_plain_folder_in_the_home(self, temp_home):
        # Not the home itself and not a hidden folder: the browser's folder
        # picker refuses the first, and people cannot find the second.
        folder = pm.default_exports_folder()
        assert folder.parent == temp_home
        assert not folder.name.startswith(".")


# ---------------------------------------------------------------------------
# clipboard / browser
# ---------------------------------------------------------------------------


class TestClipboard:
    def test_windows_uses_clip(self):
        with patch.object(pm.shutil, "which", return_value="C:/Windows/clip.exe"), \
             patch.object(pm.subprocess, "run", return_value=subprocess.CompletedProcess(["clip"], 0)) as run:
            assert pm.copy_to_clipboard("text", platform="win32") == "clip"
        assert run.call_args.args[0] == ["clip"]
        assert run.call_args.kwargs["input"] == b"text"

    def test_macos_uses_pbcopy(self):
        with patch.object(pm.shutil, "which", return_value="/usr/bin/pbcopy"), \
             patch.object(pm.subprocess, "run", return_value=subprocess.CompletedProcess(["pbcopy"], 0)):
            assert pm.copy_to_clipboard("text", platform="darwin") == "pbcopy"

    def test_linux_falls_through_to_the_first_installed_tool(self):
        def which(name):
            return "/usr/bin/xclip" if name == "xclip" else None

        with patch.object(pm.shutil, "which", side_effect=which), \
             patch.object(pm.subprocess, "run", return_value=subprocess.CompletedProcess(["xclip"], 0)) as run:
            assert pm.copy_to_clipboard("text", platform="linux") == "xclip"
        assert run.call_args.args[0][0] == "xclip"

    def test_the_tools_own_output_is_not_piped_back(self):
        # wl-copy and xclip leave a process behind that serves the clipboard.
        # It inherits the pipes of a captured run, and reading them to the end
        # would then wait for the whole timeout and report a failed copy.
        with patch.object(pm.shutil, "which", return_value="/usr/bin/wl-copy"), \
             patch.object(pm.subprocess, "run", return_value=subprocess.CompletedProcess(["wl-copy"], 0)) as run:
            assert pm.copy_to_clipboard("text", platform="linux") == "wl-copy"
        kwargs = run.call_args.kwargs
        assert kwargs["stdout"] is subprocess.DEVNULL
        assert kwargs["stderr"] is subprocess.DEVNULL
        assert "capture_output" not in kwargs

    def test_no_tool_or_failing_tool_returns_none(self):
        with patch.object(pm.shutil, "which", return_value=None):
            assert pm.copy_to_clipboard("text", platform="linux") is None
        with patch.object(pm.shutil, "which", return_value="/usr/bin/pbcopy"), \
             patch.object(pm.subprocess, "run", return_value=subprocess.CompletedProcess(["pbcopy"], 1)):
            assert pm.copy_to_clipboard("text", platform="darwin") is None
        with patch.object(pm.shutil, "which", return_value="/usr/bin/pbcopy"), \
             patch.object(pm.subprocess, "run", side_effect=OSError("boom")):
            assert pm.copy_to_clipboard("text", platform="darwin") is None
        with patch.object(pm.shutil, "which", return_value="/usr/bin/pbcopy"), \
             patch.object(pm.subprocess, "run", side_effect=subprocess.TimeoutExpired(["pbcopy"], 10)):
            assert pm.copy_to_clipboard("text", platform="darwin") is None

    def test_open_url_swallows_browser_errors(self):
        with patch.object(pm.webbrowser, "open", side_effect=RuntimeError("no display")):
            assert pm.open_url("https://example.invalid") is False
        with patch.object(pm.webbrowser, "open", return_value=True) as opened:
            assert pm.open_url("https://example.invalid") is True
        assert opened.call_args.args[0] == "https://example.invalid"


# ---------------------------------------------------------------------------
# checking an exported folder
# ---------------------------------------------------------------------------


class TestReadExport:
    def test_a_finished_claude_code_export(self, tmp_path):
        root = _make_export(tmp_path, "Demo")
        result = pm.read_export(root)
        assert result.error == ""
        assert (result.name, result.kind) == ("Demo", "code")
        assert (result.files, result.conversations, result.bytes) == (2, 2, _CODE_BYTES)
        assert result.missing == [] and result.wrong_size == [] and result.problems == []
        assert result.complete
        assert result.finished_at == pytest.approx((root / pm.MANIFEST_NAME).stat().st_mtime)

    def test_a_finished_regular_export_counts_its_memory(self, tmp_path):
        result = pm.read_export(_make_export(tmp_path, "Recipes", kind="standard"))
        assert (result.name, result.kind) == ("Recipes", "standard")
        # One chat and the project memory.
        assert (result.files, result.conversations, result.bytes) == (2, 2, _STANDARD_BYTES)
        assert result.complete

    def test_a_file_that_is_not_there_is_listed(self, tmp_path):
        root = _make_export(tmp_path)
        (root / "Files" / "notes.md").unlink()
        (root / "Threads" / "001 Kick-off.md").unlink()
        result = pm.read_export(root)
        assert result.missing == ["Files/notes.md", "Threads/001 Kick-off.md"]
        assert not result.complete
        # What is there is still counted.
        assert result.bytes == _CODE_BYTES - len(_CODE_FILES["Files/notes.md"]) - len(b"thread\n")

    def test_a_folder_where_a_file_should_be_is_missing(self, tmp_path):
        root = _make_export(tmp_path)
        (root / "Files" / "notes.md").unlink()
        (root / "Files" / "notes.md").mkdir()
        assert pm.read_export(root).missing == ["Files/notes.md"]

    def test_a_file_cut_short_is_listed(self, tmp_path):
        root = _make_export(tmp_path)
        (root / "Files" / "notes.md").write_bytes(b"# no")
        result = pm.read_export(root)
        assert result.missing == []
        assert len(result.wrong_size) == 1
        assert "Files/notes.md" in result.wrong_size[0]
        assert "4 bytes on disk, 8 in export.json" in result.wrong_size[0]
        assert not result.complete

    def test_sizes_are_only_compared_where_they_were_recorded(self, tmp_path):
        # A regular project's export records no sizes: its files can be saved
        # as another copy than the one the site lists.
        root = _make_export(tmp_path, kind="standard")
        (root / "Files" / "notes.md").write_bytes(b"shorter")
        assert pm.read_export(root).complete
        # Nor is a size that is not a count of bytes held against the file.
        root = _make_export(tmp_path, "Odd")
        manifest = _manifest(root)
        manifest["files"][0]["bytes"] = "8"
        manifest["files"][1]["bytes"] = True
        _write_manifest(root, manifest)
        assert pm.read_export(root).complete

    @pytest.mark.parametrize(
        "path",
        [
            "../outside.txt",
            "Files/../../outside.txt",
            "/outside.txt",
            "C:/outside.txt",
            "Files\\notes.md",
            "Files//notes.md",
            "./Files/notes.md",
            "",
        ],
    )
    def test_a_path_that_could_leave_the_export_is_not_followed(self, tmp_path, path):
        root = _make_export(tmp_path / "exports")
        (tmp_path / "exports" / "outside.txt").write_bytes(b"x" * 500)
        (tmp_path / "outside.txt").write_bytes(b"x" * 500)
        manifest = _manifest(root)
        manifest["history"].append({"path": path})
        _write_manifest(root, manifest)
        result = pm.read_export(root)
        assert result.missing == [path]
        assert result.bytes == _CODE_BYTES
        assert pm._inside(root, path) is None

    def test_inside_joins_plain_names(self, tmp_path):
        assert pm._inside(tmp_path, "Files/data/table.csv") == tmp_path / "Files" / "data" / "table.csv"
        assert pm._inside(tmp_path, "Timeline.md") == tmp_path / "Timeline.md"
        # Names an export really has: spaces, dots and characters outside ASCII.
        assert pm._inside(tmp_path, "Threads/001 Caf\u00e9 \u2013 notes\u2026.md") is not None
        assert pm._inside(tmp_path, "Files/..hidden") is not None

    def test_rows_that_name_no_file_are_skipped(self, tmp_path):
        root = tmp_path / "Odd"
        _write_manifest(root, {
            "format": pm.MANIFEST_FORMAT,
            "version": pm.MANIFEST_VERSION,
            "kind": "code",
            "files": [5, None, {"name": "no path"}, {"path": 7}],
            "history": "not a list",
            "memory": {"path": None},
        })
        result = pm.read_export(root)
        assert (result.files, result.conversations, result.bytes) == (0, 0, 0)
        assert result.complete
        # No name in the file: the folder's name stands in.
        assert result.name == "Odd"

    def test_what_the_export_could_not_get_is_kept(self, tmp_path):
        root = _make_export(tmp_path, problems=("The log of session s1.", "The timeline."))
        result = pm.read_export(root)
        assert result.problems == ["The log of session s1.", "The timeline."]
        # The export still holds everything it lists.
        assert result.complete

    def test_no_manifest(self, tmp_path):
        result = pm.read_export(tmp_path)
        assert "could not be read" in result.error
        assert not result.complete

    def test_a_damaged_manifest(self, tmp_path):
        _write_manifest(tmp_path / "Half", '{"format": "claude-project-export", "ver')
        result = pm.read_export(tmp_path / "Half")
        assert "damaged" in result.error
        assert not result.complete
        assert result.name == "Half"

    @pytest.mark.parametrize("payload", [[1, 2], "text", {"format": "something-else", "version": 1, "kind": "code"}, {}])
    def test_a_manifest_of_something_else(self, tmp_path, payload):
        _write_manifest(tmp_path, json.dumps(payload))
        assert "was not written by the project exporter" in pm.read_export(tmp_path).error

    @pytest.mark.parametrize("version", [2, 0, 2.5, "1", True, None])
    def test_a_format_this_cswap_does_not_know(self, tmp_path, version):
        _write_manifest(tmp_path, {"format": pm.MANIFEST_FORMAT, "version": version, "kind": "code"})
        result = pm.read_export(tmp_path)
        assert "version" in result.error and "upgrade cswap" in result.error
        assert not result.complete

    @pytest.mark.parametrize("version", [1, 1.5])
    def test_a_later_revision_of_the_same_format_is_read(self, tmp_path, version):
        # As in the import script: anything from 1 up to, not including, 2.
        _write_manifest(tmp_path, {"format": pm.MANIFEST_FORMAT, "version": version, "kind": "standard"})
        assert pm.read_export(tmp_path).complete

    @pytest.mark.parametrize("kind", ["team", "", None, 3])
    def test_an_unknown_kind_of_project(self, tmp_path, kind):
        _write_manifest(tmp_path, {"format": pm.MANIFEST_FORMAT, "version": 1, "kind": kind})
        assert "what kind of project" in pm.read_export(tmp_path).error


class TestCheckFolder:
    def test_a_folder_that_does_not_exist(self, tmp_path):
        result = pm.check_folder(tmp_path / "nowhere")
        assert not result.exists
        assert result.exports == [] and result.ready is None and not result.export_ready

    def test_an_empty_folder(self, tmp_path):
        result = pm.check_folder(tmp_path)
        assert result.exists and not result.direct
        assert result.exports == [] and result.unfinished == [] and result.ready is None

    def test_exports_are_found_newest_first(self, tmp_path):
        _make_export(tmp_path, "Older", age=600)
        _make_export(tmp_path, "Newest")
        _make_export(tmp_path, "Oldest", kind="standard", age=6000)
        result = pm.check_folder(tmp_path)
        assert [export.name for export in result.exports] == ["Newest", "Older", "Oldest"]
        assert [export.name for export in result.own] == ["Newest", "Older", "Oldest"]
        assert result.ready.name == "Newest"
        assert result.export_ready

    def test_an_export_from_before_the_move_is_not_its_own(self, tmp_path):
        _make_export(tmp_path, "Earlier", age=3600)
        result = pm.check_folder(tmp_path, since=time.time())
        assert [export.name for export in result.exports] == ["Earlier"]
        assert result.exports[0].complete
        assert result.own == [] and result.ready is None and not result.export_ready

    def test_only_exports_of_this_move_are_its_own(self, tmp_path):
        _make_export(tmp_path, "Earlier", age=3600)
        _make_export(tmp_path, "Mine", age=10)
        result = pm.check_folder(tmp_path, since=time.time() - 60)
        assert [export.name for export in result.exports] == ["Mine", "Earlier"]
        assert [export.name for export in result.own] == ["Mine"]

    def test_times_kept_to_the_second_do_not_drop_an_export(self, tmp_path):
        # The move's start is kept to the second and some file systems keep
        # times to two: an export finished the moment the move began is its own.
        root = _make_export(tmp_path, "Close")
        finished = (root / pm.MANIFEST_NAME).stat().st_mtime
        assert pm.check_folder(tmp_path, since=finished + 1.5).ready is not None
        assert pm.check_folder(tmp_path, since=finished + 60).ready is None

    def test_a_folder_that_is_itself_an_export_is_taken_as_meant(self, tmp_path):
        root = _make_export(tmp_path, "Earlier", age=3600)
        result = pm.check_folder(root, since=time.time())
        assert result.direct
        assert result.ready is not None and result.ready.path == root

    def test_an_export_missing_files_is_found_but_not_ready(self, tmp_path):
        root = _make_export(tmp_path, "Broken")
        (root / "Timeline.md").unlink()
        result = pm.check_folder(tmp_path)
        assert [export.name for export in result.exports] == ["Broken"]
        assert result.ready is None
        # A whole one is preferred to a newer one that is not.
        _make_export(tmp_path, "Whole", age=600)
        assert pm.check_folder(tmp_path).ready.name == "Whole"

    @pytest.mark.parametrize("marker", ["Project Instructions.md", "Channel Info.md", "Timeline.md"])
    def test_an_export_that_did_not_finish_is_named(self, tmp_path, marker):
        (tmp_path / "Half").mkdir()
        (tmp_path / "Half" / marker).write_text("...", encoding="utf-8")
        result = pm.check_folder(tmp_path)
        assert result.unfinished == ["Half"]
        assert result.exports == [] and result.ready is None
        # Named directly, it is the same story.
        direct = pm.check_folder(tmp_path / "Half")
        assert direct.unfinished == ["Half"] and not direct.direct and direct.ready is None

    def test_whatever_else_is_in_the_folder_is_left_alone(self, tmp_path):
        (tmp_path / "Holiday photos").mkdir()
        (tmp_path / "Holiday photos" / "beach.jpg").write_bytes(b"jpg")
        (tmp_path / "notes.txt").write_text("hello", encoding="utf-8")
        (tmp_path / pm.MANIFEST_NAME).mkdir()  # a folder by that name is not a manifest
        result = pm.check_folder(tmp_path)
        assert result.exists and not result.direct
        assert result.exports == [] and result.unfinished == []

    def test_a_file_where_the_folder_should_be(self, tmp_path):
        (tmp_path / "exports").write_text("not a folder", encoding="utf-8")
        assert not pm.check_folder(tmp_path / "exports").exists


class TestSettleAndTarget:
    def test_the_export_found_is_the_one(self, tmp_path):
        root = _make_export(tmp_path, "Mine")
        result = pm.check_folder(tmp_path)
        chosen = pm.settle_export(result)
        assert chosen.path == root
        # One export of this move: that is the folder to choose in the browser.
        assert pm.import_target(result, chosen) == root

    def test_several_exports_point_at_the_folder_that_holds_them(self, tmp_path):
        _make_export(tmp_path, "One")
        _make_export(tmp_path, "Two", kind="standard", age=30)
        result = pm.check_folder(tmp_path)
        chosen = pm.settle_export(result)
        assert chosen.name == "One"
        assert pm.import_target(result, chosen) == tmp_path

    def test_nothing_ready_points_at_the_folder(self, tmp_path):
        result = pm.check_folder(tmp_path)
        assert pm.settle_export(result) is None
        assert pm.import_target(result, None) == tmp_path

    def test_an_export_named_directly_is_the_target(self, tmp_path):
        root = _make_export(tmp_path, "Earlier", age=3600)
        result = pm.check_folder(root, since=time.time())
        chosen = pm.settle_export(result, remembered=str(tmp_path / "elsewhere"))
        assert chosen.path == root
        assert pm.import_target(result, chosen) == root

    def test_an_export_settled_on_earlier_is_kept(self, tmp_path):
        # `check --folder <export>` settled on one from before the move; the
        # next stage looks at the folder that holds it and must not drop it.
        earlier = _make_export(tmp_path, "Earlier", age=3600)
        result = pm.check_folder(tmp_path, since=time.time())
        assert result.ready is None
        chosen = pm.settle_export(result, remembered=str(earlier))
        assert chosen is not None and chosen.path == earlier
        assert pm.import_target(result, chosen) == earlier

    def test_a_newer_export_replaces_the_one_settled_on(self, tmp_path):
        earlier = _make_export(tmp_path, "Earlier", age=3600)
        newer = _make_export(tmp_path, "Newer")
        result = pm.check_folder(tmp_path, since=time.time() - 60)
        chosen = pm.settle_export(result, remembered=str(earlier))
        assert chosen.path == newer
        assert pm.import_target(result, chosen) == newer

    def test_a_remembered_export_that_is_gone_or_broken_is_dropped(self, tmp_path):
        mine = _make_export(tmp_path, "Mine")
        result = pm.check_folder(tmp_path)
        assert pm.settle_export(result, remembered=str(tmp_path / "Deleted")).path == mine
        # The folder that holds the exports is what is remembered when there are several.
        assert pm.settle_export(result, remembered=str(tmp_path)).path == mine
        broken = _make_export(tmp_path / "other", "Broken")
        (broken / "Timeline.md").unlink()
        assert pm.settle_export(result, remembered=str(broken)).path == mine
        assert pm.settle_export(pm.check_folder(tmp_path / "empty"), remembered=str(broken)) is None


class TestArchive:
    """An export saved as one .tar file: the browser's way when it opens no folder window."""

    def test_an_export_saved_as_one_file(self, tmp_path):
        archive = _make_archive(tmp_path)
        # The long path needs a GNU long-name entry; the reader has to take it.
        assert b"././@LongLink" in archive.read_bytes()
        result = pm.check_folder(archive, since=time.time() + 3600)
        assert result.exists and result.direct
        export = result.ready
        assert export is not None and result.export_ready
        assert export.archive == archive and export.path == archive
        assert (export.name, export.kind) == ("beethoven", "code")
        assert (export.files, export.conversations, export.bytes) == (3, 2, _ARCHIVE_BYTES)
        assert export.missing == [] and export.wrong_size == [] and export.problems == []
        assert export.finished_at == pytest.approx(archive.stat().st_mtime)
        assert pm.import_target(result, export) == archive

    def test_a_regular_project_counts_its_memory(self, tmp_path):
        export = pm.read_export_tar(_make_archive(tmp_path, "Recipes", kind="standard"))
        assert (export.name, export.kind) == ("Recipes", "standard")
        assert (export.files, export.conversations, export.bytes) == (3, 2, _STANDARD_BYTES + len(_LONG_DATA))
        assert export.complete

    def test_export_json_at_the_top_of_the_archive_is_taken_too(self, tmp_path):
        root = _make_export(tmp_path / "unpacked", "Demo")
        archive = tmp_path / "flat.tar"
        with tarfile.open(archive, "w") as tar:
            for file in sorted(p for p in root.rglob("*") if p.is_file()):
                tar.add(file, arcname=file.relative_to(root).as_posix())
        export = pm.read_export_tar(archive)
        assert export.complete
        assert export.name == "Demo"
        assert (export.files, export.conversations, export.bytes) == (2, 2, _CODE_BYTES)

    def test_a_tar_is_listed_beside_folder_exports(self, tmp_path):
        _make_export(tmp_path, "Older", age=600)
        _make_export(tmp_path, "Oldest", kind="standard", age=6000)
        archive = _make_archive(tmp_path)
        result = pm.check_folder(tmp_path)
        assert result.exists and not result.direct
        assert [export.name for export in result.exports] == ["beethoven", "Older", "Oldest"]
        assert [export.archive for export in result.exports] == [archive, None, None]
        assert [export.name for export in result.own] == ["beethoven", "Older", "Oldest"]
        # Several are ready, but a .tar is chosen as a file in the browser,
        # not picked out of the folder: the import is pointed at the file.
        chosen = pm.settle_export(result)
        assert chosen.archive == archive
        assert pm.import_target(result, chosen) == archive
        # With a folder export chosen among several, it is the folder as before.
        assert pm.import_target(result, result.exports[1]) == tmp_path

    def test_a_tar_from_before_the_move_is_not_its_own(self, tmp_path):
        archive = _make_archive(tmp_path, age=3600)
        result = pm.check_folder(tmp_path, since=time.time())
        assert [export.archive for export in result.exports] == [archive]
        assert result.exports[0].complete and result.ready is None
        # Named directly, it is taken as meant.
        assert pm.check_folder(archive, since=time.time()).ready is not None

    def test_a_remembered_tar_is_honoured(self, tmp_path):
        archive = _make_archive(tmp_path / "downloads", age=3600)
        (tmp_path / "exports").mkdir()
        result = pm.check_folder(tmp_path / "exports", since=time.time())
        assert result.ready is None
        chosen = pm.settle_export(result, remembered=str(archive))
        assert chosen is not None and chosen.archive == archive
        assert pm.import_target(result, chosen) == archive
        # Gone or broken, it is dropped as a folder would be.
        assert pm.settle_export(result, remembered=str(tmp_path / "gone.tar")) is None
        broken = _make_archive(tmp_path / "other", before=lambda root: (root / "Timeline.md").unlink())
        assert pm.settle_export(result, remembered=str(broken)) is None

    def test_a_file_missing_from_the_archive_is_listed(self, tmp_path):
        def drop(root: Path) -> None:
            (root / "Files" / "notes.md").unlink()
            (root / "Threads" / "001 Kick-off.md").unlink()

        result = pm.check_folder(_make_archive(tmp_path, before=drop))
        export = result.exports[0]
        assert export.missing == ["Files/notes.md", "Threads/001 Kick-off.md"]
        assert export.wrong_size == []
        # What is there is still counted.
        assert export.bytes == _ARCHIVE_BYTES - len(_CODE_FILES["Files/notes.md"]) - len(b"thread\n")
        assert not export.complete and result.ready is None

    def test_a_file_in_another_size_is_listed(self, tmp_path):
        archive = _make_archive(tmp_path, before=lambda root: (root / "Files" / "notes.md").write_bytes(b"# no"))
        export = pm.read_export_tar(archive)
        assert export.missing == []
        assert len(export.wrong_size) == 1
        assert "Files/notes.md" in export.wrong_size[0]
        assert "4 bytes in the .tar, 8 in export.json" in export.wrong_size[0]
        assert not export.complete

    @pytest.mark.parametrize(
        "path",
        ["../outside.txt", "Files/../../outside.txt", "/outside.txt", "Files\\notes.md", "Files//notes.md", "./Files/notes.md"],
    )
    def test_an_entry_whose_path_could_leave_the_export_is_not_followed(self, tmp_path, path):
        # export.json lists the path, and the archive holds an entry by that
        # very name as well as the file it would lead to. Neither is matched.
        def list_it(root: Path) -> None:
            manifest = _manifest(root)
            manifest["history"].append({"path": path})
            _write_manifest(root, manifest)

        archive = _make_archive(tmp_path, before=list_it)
        with tarfile.open(archive, "a") as tar:
            for name in (f"beethoven/{path}", "outside.txt", "beethoven/outside.txt"):
                entry = tarfile.TarInfo(name)
                entry.size = 500
                tar.addfile(entry, io.BytesIO(b"x" * 500))
        export = pm.read_export_tar(archive)
        assert export.missing == [path]
        assert export.bytes == _ARCHIVE_BYTES

    def test_what_is_not_a_whole_export_is_said_and_nothing_raises(self, tmp_path):
        # Not a tar at all: some other file by that name.
        noise = tmp_path / "noise.tar"
        noise.write_bytes(b"not a tar archive\n" * 40)
        result = pm.check_folder(noise)
        assert result.exists and result.direct and result.ready is None
        export = result.exports[0]
        assert export.archive == noise and export.name == "noise"
        assert "not a tar archive" in export.error and export.unrelated
        # An empty file, and blocks of the right size that are no headers.
        (tmp_path / "empty.tar").write_bytes(b"")
        empty = pm.read_export_tar(tmp_path / "empty.tar")
        assert "not a tar archive" in empty.error and empty.unrelated
        garbage = tmp_path / "garbage.tar"
        garbage.write_bytes(b"\xff" * 1024 + bytes(1024))
        assert "not a tar archive" in pm.read_export_tar(garbage).error
        # A tar of something else.
        with tarfile.open(tmp_path / "other.tar", "w") as tar:
            entry = tarfile.TarInfo("readme.txt")
            entry.size = 2
            tar.addfile(entry, io.BytesIO(b"hi"))
        other = pm.read_export_tar(tmp_path / "other.tar")
        assert "holds no export.json" in other.error and other.unrelated
        # One cut short, as a download that did not finish is: an export
        # that went wrong, whether it ends after a whole entry or inside one.
        archive = _make_archive(tmp_path)
        data = archive.read_bytes()
        cut = pm.read_export_tar(_cut_short(archive))
        assert "cut short" in cut.error and "export the project again" in cut.error
        assert not cut.unrelated
        archive.write_bytes(data[: len(data) // 2 + 100])
        cut = pm.read_export_tar(archive)
        assert "cut short" in cut.error and not cut.unrelated
        # A damaged export.json inside.
        half = _make_archive(tmp_path, "Half", before=lambda root: _write_manifest(root, '{"format": "cl'))
        assert "not valid JSON" in pm.read_export_tar(half).error
        # Two exports in one.
        two = tmp_path / "two.tar"
        with tarfile.open(two, "w") as tar:
            for name in ("one", "two"):
                tar.add(_make_export(tmp_path / "pair", name), arcname=name)
        assert "holds 2 exports" in pm.read_export_tar(two).error
        # In the folder, the exports that went wrong are listed and none is
        # ready; what is no export is left out; nothing raised.
        listed = pm.check_folder(tmp_path)
        assert sorted(export.path.name for export in listed.exports) == ["Half.tar", "beethoven.tar", "two.tar"]
        assert listed.ready is None
        assert all(export.error and export.archive is not None for export in listed.exports)

    def test_a_tar_of_something_else_is_not_listed_beside_an_export(self, tmp_path):
        archive = _make_archive(tmp_path)
        # Someone else's tar, a file that is no tar, and a copy of the
        # export whose download did not finish.
        with tarfile.open(tmp_path / "node_modules.tar", "w") as tar:
            entry = tarfile.TarInfo("node_modules/left-pad/index.js")
            entry.size = 2
            tar.addfile(entry, io.BytesIO(b"hi"))
        (tmp_path / "x.tar").write_bytes(b"not a tar\n" * 50)
        _cut_short(Path(shutil.copy(archive, tmp_path / "cut.tar")))
        result = pm.check_folder(tmp_path)
        assert sorted(export.path.name for export in result.exports) == ["beethoven.tar", "cut.tar"]
        assert result.ready is not None and result.ready.archive == archive
        by_name = {export.path.name: export for export in result.exports}
        assert "cut short" in by_name["cut.tar"].error
        # Named directly, each is explained all the same.
        for name, said in (("node_modules.tar", "holds no export.json"), ("x.tar", "not a tar archive")):
            direct = pm.check_folder(tmp_path / name)
            assert direct.direct and direct.ready is None
            assert said in direct.exports[0].error and direct.exports[0].unrelated

    def test_a_download_that_stopped_before_export_json_is_still_an_export(self, tmp_path):
        # An export writes export.json last, so a download cut short seldom
        # has it. The files an export writes first say what the .tar was.
        def cut_short(name: str, *paths: str) -> Path:
            archive = tmp_path / name
            with tarfile.open(archive, "w") as tar:
                for path in paths:
                    entry = tarfile.TarInfo(path)
                    entry.size = 2
                    tar.addfile(entry, io.BytesIO(b"hi"))
            return _cut_short(archive)

        begun = cut_short("begun.tar", "beethoven/Channel Info.md", "beethoven/Files/notes.md")
        other = cut_short("other.tar", "node_modules/left-pad/index.js")
        for archive in (begun, other):
            assert "cut short" in pm.read_export_tar(archive).error
        assert not pm.read_export_tar(begun).unrelated
        assert pm.read_export_tar(other).unrelated
        assert [export.path for export in pm.check_folder(tmp_path).exports] == [begun]

    def test_a_tar_that_is_not_there(self, tmp_path):
        result = pm.check_folder(tmp_path / "nowhere.tar")
        assert not result.exists and result.exports == [] and result.ready is None
        # A folder by that name is a folder like any other.
        _make_export(tmp_path / "odd.tar", "Demo")
        assert pm.check_folder(tmp_path / "odd.tar").ready is not None

    def test_the_steps_name_the_tar_button(self, tmp_path):
        archive = _make_archive(tmp_path)
        state = pm.MoveState(
            carrier=pm.CARRIER_FOLDER,
            folder=str(tmp_path),
            exported_at="t",
            export_seen_at="t",
            export_path=str(archive),
        )
        _, title, how = pm.steps(state)[5]
        assert 'press "Import from a .tar file instead" and choose this file' in title
        assert how == str(archive)
        # From a fresh look at the folder as well.
        state.export_path = ""
        rows = pm.steps(state, pm.check_folder(tmp_path))
        assert "Import from a .tar file instead" in rows[5][1] and rows[5][2] == str(archive)
        # A folder export keeps the folder wording.
        rows = pm.steps(pm.MoveState())
        assert rows[5][1].endswith("then choose this folder") and ".tar" not in rows[5][1]

    def test_resolve_folder_takes_a_tar(self, temp_home):
        archive = pm.resolve_folder(pm.MoveState(), "~/Downloads/beethoven.tar")
        assert archive == temp_home / "Downloads" / "beethoven.tar"
        assert pm.is_archive(archive) and pm.is_archive(Path("Beethoven.TAR"))
        assert not pm.is_archive(temp_home / "Downloads") and not pm.is_archive(Path("notes.tar.txt"))


class TestSizeText:
    @pytest.mark.parametrize(
        "count, text",
        [
            (0, "0 bytes"),
            (812, "812 bytes"),
            (1023, "1023 bytes"),
            (1024, "1.0 KB"),
            (4915, "4.8 KB"),
            (1024 * 1024, "1.0 MB"),
            (int(1.9 * 1024 * 1024), "1.9 MB"),
            (3 * 1024 * 1024 * 1024, "3.0 GB"),
        ],
    )
    def test_size_text(self, count, text):
        assert pm.size_text(count) == text


# ---------------------------------------------------------------------------
# GitHub checks
# ---------------------------------------------------------------------------


class TestCheckRepo:
    def test_export_ready_when_branch_and_readme_exist(self):
        urlopen = _fake_github({
            f"/repos/{REPO}": (200, _REPO_PRIVATE),
            f"/repos/{REPO}/branches/project-export": (200, {}),
            f"/repos/{REPO}/contents/{pm.EXPORT_DIR}/README.md?ref=project-export": (200, {}),
        })
        with patch.object(pm.urllib.request, "urlopen", urlopen):
            result = pm.check_repo(REPO, "project-export", token="tok")
        assert result.exists is True
        assert result.private is True
        assert result.branch_exists is True
        assert result.export_readme is True
        assert result.export_ready
        assert result.error == ""
        # The token rides along as a bearer header on every call.
        assert all(h.get("Authorization") == "Bearer tok" for _, h in urlopen.calls)

    def test_branch_without_readme_is_not_ready(self):
        urlopen = _fake_github({
            f"/repos/{REPO}": (200, _REPO_PUBLIC),
            f"/repos/{REPO}/branches/project-export": (200, {}),
        })
        with patch.object(pm.urllib.request, "urlopen", urlopen):
            result = pm.check_repo(REPO, "project-export")
        assert result.private is False
        assert result.branch_exists is True
        assert result.export_readme is False
        assert not result.export_ready
        assert not any("Authorization" in h for _, h in urlopen.calls)

    def test_missing_branch(self):
        urlopen = _fake_github({f"/repos/{REPO}": (200, _REPO_PUBLIC)})
        with patch.object(pm.urllib.request, "urlopen", urlopen):
            result = pm.check_repo(REPO, "project-export")
        assert result.branch_exists is False
        assert result.export_readme is False
        assert len(urlopen.calls) == 2  # no README lookup without a branch

    def test_404_without_token_is_ambiguous(self):
        with patch.object(pm.urllib.request, "urlopen", _fake_github({})):
            result = pm.check_repo(REPO, "project-export")
        assert result.exists is None
        assert "private" in result.error

    def test_404_with_token_means_missing(self):
        with patch.object(pm.urllib.request, "urlopen", _fake_github({})):
            result = pm.check_repo(REPO, "project-export", token="tok")
        assert result.exists is False
        assert result.error == "repository not found"

    def test_403_is_reported_not_raised(self):
        with patch.object(pm.urllib.request, "urlopen", _fake_github({f"/repos/{REPO}": (403, None)})):
            result = pm.check_repo(REPO, "project-export")
        assert result.exists is None
        assert "refused" in result.error

    def test_network_error_is_reported_not_raised(self):
        with patch.object(pm.urllib.request, "urlopen", side_effect=urllib.error.URLError("down")):
            result = pm.check_repo(REPO, "project-export")
        assert result.exists is None
        assert "unreachable" in result.error

    def test_github_token_order(self, monkeypatch):
        monkeypatch.setenv("GITHUB_TOKEN", "env-gh")
        monkeypatch.setenv("GH_TOKEN", "env-ghcli")
        assert pm.github_token("flag") == "flag"
        assert pm.github_token(None) == "env-gh"
        monkeypatch.delenv("GITHUB_TOKEN")
        assert pm.github_token("  ") == "env-ghcli"
        monkeypatch.delenv("GH_TOKEN")
        assert pm.github_token(None) is None


# ---------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------


class TestSteps:
    """The step list of a move by prompt, with a branch as the carrier."""

    def test_fresh_state_marks_the_first_step_next(self):
        rows = pm.steps(pm.MoveState(carrier=pm.CARRIER_BRANCH))
        assert [s for s, _, _ in rows] == ["next", "todo", "todo", "todo", "todo", "todo"]
        command, hint = rows[0][2].splitlines()
        assert command == "cswap project-move export OWNER/NAME"
        # Until a repository is known, say which name goes there.
        assert "not the project's name" in hint

    def test_remembered_repo_needs_no_hint(self):
        rows = pm.steps(pm.MoveState(repo=REPO))
        assert rows[0][2] == f"cswap project-move export {REPO}"

    def test_progress_moves_the_next_marker(self):
        state = pm.MoveState(repo=REPO, exported_at="t")
        assert [s for s, _, _ in pm.steps(state)] == ["done", "done", "next", "todo", "todo", "todo"]
        state.branch_seen_at = "t"
        assert [s for s, _, _ in pm.steps(state)][2:4] == ["done", "next"]
        state.imported_at = "t"
        assert all(s == "done" for s, _, _ in pm.steps(state))

    def test_live_check_overrides_remembered_branch(self):
        state = pm.MoveState(repo=REPO, exported_at="t", branch_seen_at="t")
        not_ready = pm.RepoCheck(repo=REPO, branch="project-export", branch_exists=False)
        assert [s for s, _, _ in pm.steps(state, not_ready)][2] == "next"

    def test_non_default_branch_is_spelled_out(self):
        rows = pm.steps(pm.MoveState(repo=REPO, branch="other"))
        assert rows[0][2] == f"cswap project-move export {REPO} --branch other"

    def test_a_check_of_the_other_carrier_is_not_used(self, tmp_path):
        _make_export(tmp_path)
        state = pm.MoveState(repo=REPO, exported_at="t")
        assert [s for s, _, _ in pm.steps(state, pm.check_folder(tmp_path))][2] == "next"


class TestFolderSteps:
    """The step list of a move by browser script, with a folder as the carrier."""

    def test_fresh_state_is_a_move_by_script(self, temp_home):
        rows = pm.steps(pm.MoveState())
        assert [s for s, _, _ in rows] == ["next", "todo", "todo", "todo", "todo", "todo"]
        assert rows[0][2] == "cswap project-move export"
        assert rows[1][2] == str(_exports(temp_home))
        assert rows[2][2] == "cswap project-move check"
        assert rows[4][2] == "cswap project-move import"
        assert rows[5][2] == str(_exports(temp_home))

    def test_another_folder_is_spelled_out(self, temp_home, tmp_path):
        folder = str(tmp_path / "my exports")
        rows = pm.steps(pm.MoveState(carrier=pm.CARRIER_FOLDER, folder=folder))
        assert rows[0][2] == f'cswap project-move export --folder "{folder}"'
        assert rows[1][2] == folder
        # The default one, remembered, is not.
        rows = pm.steps(pm.MoveState(carrier=pm.CARRIER_FOLDER, folder=str(_exports(temp_home))))
        assert rows[0][2] == "cswap project-move export"

    def test_progress_moves_the_next_marker(self):
        state = pm.MoveState(carrier=pm.CARRIER_FOLDER, exported_at="t")
        assert [s for s, _, _ in pm.steps(state)] == ["done", "done", "next", "todo", "todo", "todo"]
        state.export_seen_at = "t"
        assert [s for s, _, _ in pm.steps(state)][2:4] == ["done", "next"]
        state.imported_at = "t"
        assert all(s == "done" for s, _, _ in pm.steps(state))

    def test_a_fresh_look_at_the_folder_decides(self, tmp_path):
        state = pm.MoveState(carrier=pm.CARRIER_FOLDER, folder=str(tmp_path), exported_at="t", export_seen_at="t")
        # Remembered as seen, and gone since.
        assert [s for s, _, _ in pm.steps(state, pm.check_folder(tmp_path))][2] == "next"
        root = _make_export(tmp_path)
        state.export_seen_at = ""
        rows = pm.steps(state, pm.check_folder(tmp_path))
        assert rows[2][0] == "done"
        assert rows[5][2] == str(root)

    def test_the_last_step_names_the_folder_settled_on(self, tmp_path):
        state = pm.MoveState(
            carrier=pm.CARRIER_FOLDER,
            folder=str(tmp_path),
            exported_at="t",
            export_seen_at="t",
            export_path=str(tmp_path / "Demo"),
        )
        assert pm.steps(state)[5][2] == str(tmp_path / "Demo")

    def test_a_check_of_the_other_carrier_is_not_used(self):
        state = pm.MoveState(carrier=pm.CARRIER_FOLDER, exported_at="t")
        ready = pm.RepoCheck(repo=REPO, branch="b", branch_exists=True, export_readme=True)
        assert [s for s, _, _ in pm.steps(state, ready)][2] == "next"


# ---------------------------------------------------------------------------
# CLI: by prompt, with a repository
# ---------------------------------------------------------------------------


class TestCli:
    def test_export_renders_saves_and_remembers(self, temp_home, capsys):
        with patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x", private=True)):
            code, out, err = _run(["export", f"https://github.com/{REPO}", "--no-open", "--print"], capsys)
        assert code == 0
        assert "Export this project into the owner/name repository" in out
        assert "Saved the export prompt to" in out
        assert "OLD project" in out and "SOURCE account" in out
        assert "project-move check --wait" in out
        root = _state_root(temp_home)
        assert (root / pm.PROMPT_DIR / "export-prompt.md").read_text(encoding="utf-8").startswith("Export this project")
        state = pm.MoveState.load(root)
        assert state.repo == REPO
        assert state.carrier == pm.CARRIER_BRANCH
        assert state.exported_at
        assert state.imported_at == ""

    def test_export_warns_when_the_repo_is_public(self, temp_home, capsys):
        with patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x", exists=True, private=False)):
            code, out, _ = _run(["export", REPO, "--no-open"], capsys)
        assert code == 0
        assert "PUBLIC" in out

    def test_export_copies_to_clipboard_and_opens_browser(self, temp_home, capsys):
        with patch("os.geteuid", return_value=1000, create=True), \
             patch.object(sys, "argv", ["cswap", "project-move", "export", REPO, "--url", "https://claude.ai/code/x"]), \
             patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x")), \
             patch.object(pm, "open_url", return_value=True) as opened, \
             patch.object(pm, "copy_to_clipboard", return_value="clip") as copied:
            cli.main()
        out = capsys.readouterr().out
        assert "Copied the export prompt to the clipboard (clip)" in out
        assert copied.call_args.args[0].startswith("Export this project")
        assert opened.call_args.args[0] == "https://claude.ai/code/x"
        assert "Opened https://claude.ai/code/x" in out

    def test_export_by_prompt_opens_the_claude_code_page(self, temp_home, capsys):
        with patch("os.geteuid", return_value=1000, create=True), \
             patch.object(sys, "argv", ["cswap", "project-move", "export", REPO]), \
             patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x")), \
             patch.object(pm, "open_url", return_value=True) as opened, \
             patch.object(pm, "copy_to_clipboard", return_value="clip"):
            cli.main()
        capsys.readouterr()
        assert opened.call_args.args[0] == pm.CLAUDE_CODE_URL

    def test_a_branch_without_a_repository_errors(self, temp_home, capsys):
        # --branch only means something to a move by prompt, and nothing
        # says which repository.
        code, out, err = _run(["export", "--branch", "custom", "--no-open"], capsys)
        assert code == 1
        assert "No repository" in err
        assert not (_state_root(temp_home) / pm.STATE_FILE).exists()

    def test_placeholder_repo_errors_and_remembers_nothing(self, temp_home, capsys):
        with patch.object(pm, "check_repo") as check:
            code, _, err = _run(["export", "OWNER/NAME"], capsys)
        assert code == 1
        assert "placeholder" in err
        assert check.call_count == 0
        assert not (_state_root(temp_home) / pm.STATE_FILE).exists()
        # The step list still starts from the top afterwards.
        code, out, _ = _run([], capsys)
        assert code == 0
        assert "[next] 1." in out

    def test_bad_repo_spec_errors(self, temp_home, capsys):
        # A project's name is the likely mistake; the error says what to give.
        code, _, err = _run(["export", "beethoven", "--no-open"], capsys)
        assert code == 1
        assert "Not a GitHub repository: 'beethoven'" in err
        assert "not the project's name" in err

    def test_a_folder_given_where_the_repository_goes_is_explained(self, temp_home, capsys):
        code, _, err = _run(["export", "~/exports", "--no-open"], capsys)
        assert code == 1
        assert "Not a GitHub repository" in err
        assert "--folder" in err

    def test_import_uses_the_remembered_repo(self, temp_home, capsys):
        with patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x")):
            _run(["export", REPO, "--no-open", "--branch", "custom"], capsys)
        code, out, _ = _run(["import", "--no-open", "--print"], capsys)
        assert code == 0
        assert "from the `custom` branch of owner/name" in out
        assert "NEW project" in out and "DESTINATION account" in out
        state = pm.MoveState.load(_state_root(temp_home))
        assert state.branch == "custom"
        assert state.imported_at

    def test_check_not_ready_exits_2(self, temp_home, capsys):
        result = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=False, export_readme=False)
        with patch.object(pm, "check_repo", return_value=result):
            code, out, _ = _run(["check", REPO], capsys)
        assert code == 2
        assert "PRIVATE" in out
        assert "not pushed yet" in out

    def test_check_ready_records_and_points_at_import(self, temp_home, capsys):
        result = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=True, export_readme=True)
        with patch.object(pm, "check_repo", return_value=result):
            code, out, _ = _run(["check", REPO], capsys)
        assert code == 0
        assert "Export is up" in out
        assert "project-move import" in out
        assert pm.MoveState.load(_state_root(temp_home)).branch_seen_at

    def test_check_wait_polls_until_ready(self, temp_home, capsys):
        waiting = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=False, export_readme=False)
        ready = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=True, export_readme=True)
        with patch.object(pm, "check_repo", side_effect=[waiting, waiting, ready]) as check, \
             patch.object(cli.time, "sleep") as sleep:
            code, out, _ = _run(["check", REPO, "--wait", "5"], capsys)
        assert code == 0
        assert check.call_count == 3
        assert sleep.call_count == 2
        assert sleep.call_args.args == (5,)
        assert "Checking again in 5s" in out

    def test_check_wait_alone_asks_github_every_half_minute(self, temp_home, capsys):
        waiting = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=False)
        ready = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=True, export_readme=True)
        with patch.object(pm, "check_repo", side_effect=[waiting, ready]), \
             patch.object(cli.time, "sleep") as sleep:
            code, _, _ = _run(["check", REPO, "--wait"], capsys)
        assert code == 0
        assert sleep.call_args.args == (30,)

    def test_check_wait_gives_up_at_timeout(self, temp_home, capsys):
        waiting = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=False)
        clock = iter([0.0, 0.0, 100.0])
        with patch.object(pm, "check_repo", return_value=waiting), \
             patch.object(cli.time, "sleep"), \
             patch.object(cli.time, "monotonic", side_effect=lambda: next(clock, 100.0)):
            code, _, err = _run(["check", REPO, "--wait", "--timeout", "10"], capsys)
        assert code == 2
        assert "Gave up after 10s" in err

    def test_check_missing_repo_does_not_wait(self, temp_home, capsys):
        missing = pm.RepoCheck(repo=REPO, branch="project-export", exists=False, error="repository not found")
        with patch.object(pm, "check_repo", return_value=missing) as check, \
             patch.object(cli.time, "sleep") as sleep:
            code, _, err = _run(["check", REPO, "--wait", "--token", "t"], capsys)
        assert code == 2
        assert "not found" in err
        assert check.call_count == 1
        assert sleep.call_count == 0

    def test_check_passes_the_token_through(self, temp_home, capsys):
        ready = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=True, export_readme=True)
        with patch.object(pm, "check_repo", return_value=ready) as check:
            _run(["check", REPO, "--token", "sekrit"], capsys)
        assert check.call_args.args == (REPO, "project-export", "sekrit")

    def test_steps_of_a_move_by_prompt(self, temp_home, capsys):
        with patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x")):
            _run(["export", REPO, "--no-open"], capsys)
            code, out, _ = _run([], capsys)
        assert code == 0
        assert f"Project move via GitHub repository {REPO} (branch project-export)" in out
        assert f"cswap project-move export {REPO}" in out
        assert "not the project's name" not in out  # the repository is known
        assert "[next] 3." in out
        assert "cswap project-move check --wait" in out

    def test_steps_of_a_move_by_prompt_before_a_repository_is_known(self, temp_home, capsys):
        # Asked for by an option only the prompts have; nothing is remembered.
        code, out, _ = _run(["steps", "--branch", "project-export"], capsys)
        assert code == 0
        assert "Project move via GitHub repository OWNER/NAME" in out
        assert "[next] 1." in out
        assert "cswap project-move export OWNER/NAME" in out
        assert "not the project's name" in out
        assert out.count("[    ]") == 5
        assert not (_state_root(temp_home) / pm.STATE_FILE).exists()

    def test_steps_after_export_consults_github_once(self, temp_home, capsys):
        with patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x")):
            _run(["export", REPO, "--no-open"], capsys)
        ready = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=True, export_readme=True)
        with patch.object(pm, "check_repo", return_value=ready) as check:
            code, out, _ = _run(["steps"], capsys)
        assert code == 0
        assert check.call_count == 1
        assert "[done] 3." in out
        assert "[next] 4." in out
        # Once seen, the branch is remembered; no further GitHub calls.
        with patch.object(pm, "check_repo") as check:
            _run([], capsys)
        assert check.call_count == 0

    def test_steps_of_a_finished_move_say_how_to_begin_another(self, temp_home, capsys):
        ready = pm.RepoCheck(repo=REPO, branch="project-export", exists=True, private=True, branch_exists=True, export_readme=True)
        with patch.object(pm, "check_repo", return_value=ready):
            _run(["export", REPO, "--no-open"], capsys)
            _run(["check"], capsys)
            _run(["import", "--no-open"], capsys)
            code, out, _ = _run([], capsys)
        assert code == 0
        assert out.count("[done]") == 6
        assert "To move another project: cswap project-move export" in out

    def test_help_lists_the_stages(self, capsys):
        with patch.object(sys, "argv", ["cswap", "project-move", "--help"]):
            with pytest.raises(SystemExit) as e:
                cli.main()
        assert e.value.code == 0
        out = capsys.readouterr().out
        assert "export OWNER/NAME" in out
        assert "check [--wait]" in out
        assert "import [OWNER/NAME]" in out
        assert "not the project's name" in out
        # The script stages, and the option that goes with them.
        assert "copy the export script" in out
        assert "copy the import script" in out
        assert "--folder DIR" in out
        assert pm.DEFAULT_EXPORTS_DIRNAME in out

    def test_main_help_mentions_project_move(self, capsys):
        with patch.object(sys, "argv", ["cswap", "--help"]):
            with pytest.raises(SystemExit):
                cli.main()
        assert "project-move" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# CLI: by browser script, with a folder
# ---------------------------------------------------------------------------


class TestCliScripts:
    def test_export_hands_out_the_script(self, temp_home, capsys):
        code, out, _ = _run(["export", "--no-open"], capsys)
        assert code == 0
        root = _state_root(temp_home)
        saved = root / pm.PROMPT_DIR / "export-script.js"
        assert f"Saved the export script to: {saved}" in out
        assert saved.read_bytes() == pm.script_text("export").encode("utf-8")
        # The folder is made, so that it is there to choose in the browser.
        folder = _exports(temp_home)
        assert folder.is_dir()
        assert str(folder) in out
        assert "SOURCE account" in out
        assert "Chrome or Edge" in out
        assert 'Press "Export Claude Project"' in out
        assert "allow pasting" in out
        assert "memory is only in the export if its Claude has saved it" in out
        assert "Then run: cswap project-move check" in out
        state = pm.MoveState.load(root)
        assert state.carrier == pm.CARRIER_FOLDER
        assert state.folder == str(folder)
        assert state.exported_at
        assert state.imported_at == "" and state.repo == ""

    def test_the_button_names_are_the_ones_the_scripts_show(self):
        assert "'Export Claude Project'" in pm.script_text("export")
        assert "'Import Claude Project'" in pm.script_text("import")

    def test_the_tar_button_names_are_the_ones_the_scripts_show(self):
        # The words the export stage quotes begin the label of the export
        # script's second button; the import stage quotes the import
        # script's whole.
        assert "'Save as .tar instead" in pm.script_text("export")
        assert "'Import from a .tar file instead'" in pm.script_text("import")

    def test_export_copies_to_clipboard_and_opens_claude_ai(self, temp_home, capsys):
        with patch("os.geteuid", return_value=1000, create=True), \
             patch.object(sys, "argv", ["cswap", "project-move", "export"]), \
             patch.object(pm, "open_url", return_value=True) as opened, \
             patch.object(pm, "copy_to_clipboard", return_value="clip") as copied:
            cli.main()
        out = capsys.readouterr().out
        assert "Copied the export script to the clipboard (clip)." in out
        assert "Saved the export script" not in out
        assert copied.call_args.args[0] == pm.script_text("export")
        assert opened.call_args.args[0] == pm.CLAUDE_URL
        assert f"Opened {pm.CLAUDE_URL}" in out

    def test_print_writes_the_script_out_too(self, temp_home, capsys):
        code, out, _ = _run(["export", "--no-open", "--print"], capsys)
        assert code == 0
        assert pm.script_text("export") in out

    def test_no_clip_leaves_the_clipboard_alone(self, temp_home, capsys):
        with patch("os.geteuid", return_value=1000, create=True), \
             patch.object(sys, "argv", ["cswap", "project-move", "import", "--no-clip", "--no-open"]), \
             patch.object(pm, "open_url") as opened, \
             patch.object(pm, "copy_to_clipboard") as copied:
            cli.main()
        out = capsys.readouterr().out
        assert copied.call_count == 0 and opened.call_count == 0
        assert "Saved the import script to" in out
        assert "No clipboard tool found" not in out

    def test_export_into_a_folder_of_ones_own(self, temp_home, tmp_path, capsys):
        folder = tmp_path / "my exports"
        code, out, _ = _run(["export", "--folder", str(folder), "--no-open"], capsys)
        assert code == 0
        assert folder.is_dir()
        assert not _exports(temp_home).exists()
        assert str(folder) in out
        assert pm.MoveState.load(_state_root(temp_home)).folder == str(folder)
        # Remembered: the later stages need no --folder.
        _make_export(folder)
        code, out, _ = _run(["check"], capsys)
        assert code == 0
        assert str(folder) in out.splitlines()
        code, out, _ = _run([], capsys)
        assert f'cswap project-move export --folder "{folder}"' in out

    def test_a_folder_under_the_home_can_be_written_with_a_tilde(self, temp_home, capsys):
        code, _, _ = _run(["export", "--folder", "~/moves", "--no-open"], capsys)
        assert code == 0
        assert (temp_home / "moves").is_dir()
        assert pm.MoveState.load(_state_root(temp_home)).folder == str(temp_home / "moves")

    def test_a_folder_that_cannot_be_made_is_said(self, temp_home, tmp_path, capsys):
        (tmp_path / "taken").write_text("a file, not a folder", encoding="utf-8")
        code, out, _ = _run(["export", "--folder", str(tmp_path / "taken" / "exports"), "--no-open"], capsys)
        assert code == 0
        assert "Could not create" in out and "--folder" in out
        # The script is handed out all the same.
        assert "Saved the export script to" in out

    @pytest.mark.parametrize(
        "argv",
        [
            ["export", REPO, "--folder", "exports"],
            ["check", "--folder", "exports", "--token", "t"],
            ["import", "--folder", "exports", "--branch", "b"],
        ],
    )
    def test_a_folder_and_a_repository_together_are_refused(self, temp_home, capsys, argv):
        code, _, err = _run([*argv, "--no-open"], capsys)
        assert code == 1
        assert "one or the other" in err
        assert not (_state_root(temp_home) / pm.STATE_FILE).exists()

    def test_check_before_anything(self, temp_home, capsys):
        code, out, _ = _run(["check"], capsys)
        assert code == 2
        assert str(_exports(temp_home)) in out.splitlines()
        assert "does not exist yet" in out
        assert "cswap project-move export" in out

    def test_check_of_an_empty_folder_when_no_export_was_begun(self, temp_home, capsys):
        _exports(temp_home).mkdir()
        code, out, _ = _run(["check"], capsys)
        assert code == 2
        assert "No export in this folder yet." in out
        assert "To export a project into this folder: cswap project-move export" in out
        # No export script was handed out, so none can be running.
        assert "still running" not in out

    def test_check_while_the_export_is_still_to_come(self, temp_home, capsys):
        _run(["export", "--no-open"], capsys)
        code, out, _ = _run(["check"], capsys)
        assert code == 2
        assert "No export in this folder yet." in out
        assert 'wait for the page to say "Done"' in out
        assert "cswap project-move check --wait" in out
        state = pm.MoveState.load(_state_root(temp_home))
        assert state.export_seen_at == "" and state.export_path == ""

    def test_check_finds_the_export(self, temp_home, capsys):
        _run(["export", "--no-open"], capsys)
        root = _make_export(_exports(temp_home), "Demo")
        code, out, _ = _run(["check"], capsys)
        assert code == 0
        assert "Demo  (Claude Code project, saved " in out
        assert f"Export is complete: 2 file(s), 2 saved conversation(s), {_CODE_BYTES} bytes" in out
        assert "then run: cswap project-move import" in out
        state = pm.MoveState.load(_state_root(temp_home))
        assert state.export_seen_at
        assert state.export_path == str(root)
        assert state.imported_at == ""

    def test_check_of_a_regular_project(self, temp_home, capsys):
        _make_export(_exports(temp_home), "Recipes", kind="standard")
        code, out, _ = _run(["check"], capsys)
        assert code == 0
        assert "Recipes  (project, saved " in out
        assert f"Export is complete: 2 file(s), 2 saved conversation(s), {_STANDARD_BYTES} bytes" in out

    def test_check_of_a_broken_export_named_directly(self, temp_home, tmp_path, capsys):
        root = _make_export(tmp_path, "Demo")
        (root / "Timeline.md").unlink()
        code, out, _ = _run(["check", "--folder", str(root)], capsys)
        assert code == 2
        assert "Export is NOT complete" in out and "Export the project again." in out
        # Not the folder to export into: that is the one it sits in.
        assert "To export a project into this folder" not in out
        assert pm.MoveState.load(_state_root(temp_home)).folder == str(tmp_path)

    def test_check_says_what_an_export_is_missing(self, temp_home, capsys):
        root = _make_export(_exports(temp_home), "Demo")
        (root / "Files" / "notes.md").unlink()
        (root / "Files" / "data" / "table.csv").write_bytes(b"a,b\n")
        code, out, _ = _run(["check"], capsys)
        assert code == 2
        assert "Export is NOT complete" in out
        assert "1 file(s) listed in export.json but not in the folder: Files/notes.md" in out
        assert "1 file(s) in the folder with another size than recorded: Files/data/table.csv" in out
        assert "Export the project again." in out
        assert "project-move import" not in out
        assert pm.MoveState.load(_state_root(temp_home)).export_seen_at == ""

    def test_check_shortens_a_long_list_of_missing_files(self, temp_home, capsys):
        root = _make_export(_exports(temp_home), "Demo")
        manifest = _manifest(root)
        manifest["history"] = [{"path": f"Threads/{n:03d}.md"} for n in range(1, 9)]
        _write_manifest(root, manifest)
        code, out, _ = _run(["check"], capsys)
        assert code == 2
        assert "8 file(s) listed in export.json but not in the folder: " in out
        assert "Threads/005.md (and 3 more)" in out
        assert "Threads/006.md" not in out

    def test_check_mentions_what_claude_ai_would_not_give(self, temp_home, capsys):
        _make_export(_exports(temp_home), "Demo", problems=("The log of session s1.",))
        code, out, _ = _run(["check"], capsys)
        assert code == 0
        assert "1 thing(s) could not be exported from claude.ai" in out

    def test_check_names_an_export_that_did_not_finish(self, temp_home, capsys):
        _run(["export", "--no-open"], capsys)
        half = _exports(temp_home) / "Half"
        half.mkdir()
        (half / "Channel Info.md").write_text("About.", encoding="utf-8")
        code, out, _ = _run(["check"], capsys)
        assert code == 2
        assert '"Half" has no export.json' in out
        assert "No export in this folder yet." not in out
        assert 'wait for the page to say "Done"' in out

    def test_check_explains_a_manifest_it_cannot_use(self, temp_home, capsys):
        _write_manifest(_exports(temp_home) / "Future", {"format": pm.MANIFEST_FORMAT, "version": 7, "kind": "code"})
        code, out, _ = _run(["check"], capsys)
        assert code == 2
        assert "Future" in out
        assert "Not usable:" in out and "upgrade cswap" in out

    def test_an_export_from_before_this_move_is_not_taken_for_its_export(self, temp_home, capsys):
        earlier = _make_export(_exports(temp_home), "Earlier", age=3600)
        _run(["export", "--no-open"], capsys)
        code, out, _ = _run(["check"], capsys)
        assert code == 2
        assert "Earlier  (Claude Code project, saved " in out
        assert "Saved before this move began." in out
        assert f'cswap project-move check --folder "{earlier}"' in out
        assert "then run: cswap project-move import" not in out

        # Named, it is taken as meant, and the stages after remember it.
        code, out, _ = _run(["check", "--folder", str(earlier)], capsys)
        assert code == 0
        assert "Export is complete" in out
        state = pm.MoveState.load(_state_root(temp_home))
        assert state.export_path == str(earlier)
        assert state.folder == str(_exports(temp_home))
        code, out, _ = _run(["check"], capsys)
        assert code == 0
        assert "This is the one the import will be pointed at." not in out  # the only one listed
        code, out, _ = _run(["import", "--no-open"], capsys)
        assert code == 0
        assert f"       {earlier}" in out
        assert "Export to import: Earlier (Claude Code project;" in out

    def test_without_an_export_stage_any_finished_export_will_do(self, temp_home, capsys):
        # Exported some other day, or with the script run by hand.
        root = _make_export(_exports(temp_home), "Earlier", age=86400)
        code, out, _ = _run(["check"], capsys)
        assert code == 0
        assert "Saved before this move began." not in out
        assert pm.MoveState.load(_state_root(temp_home)).export_path == str(root)

    def test_check_with_several_exports(self, temp_home, capsys):
        _run(["export", "--no-open"], capsys)
        folder = _exports(temp_home)
        _make_export(folder, "Demo")
        _make_export(folder, "Recipes", kind="standard")
        code, out, _ = _run(["check"], capsys)
        assert code == 0
        assert "Demo  (Claude Code project" in out and "Recipes  (project" in out
        assert "2 exports are ready here; the import script asks which one to import." in out
        assert pm.MoveState.load(_state_root(temp_home)).export_path == str(folder)

    def test_check_marks_the_one_among_several_that_the_import_will_use(self, temp_home, capsys):
        folder = _exports(temp_home)
        _make_export(folder, "Earlier", age=3600)
        _run(["export", "--no-open"], capsys)
        mine = _make_export(folder, "Mine")
        code, out, _ = _run(["check"], capsys)
        assert code == 0
        lines = out.splitlines()
        marked = lines.index("    This is the one the import will be pointed at.")
        assert lines[marked - 2].startswith("  Mine  (")
        assert "Saved before this move began." in out
        assert pm.MoveState.load(_state_root(temp_home)).export_path == str(mine)

    def test_check_wait_looks_again_until_the_export_is_there(self, temp_home, capsys):
        _run(["export", "--no-open"], capsys)
        naps: list[int] = []

        def sleep(seconds):
            naps.append(seconds)
            if len(naps) == 2:
                _make_export(_exports(temp_home), "Demo")

        with patch.object(cli.time, "sleep", side_effect=sleep):
            code, out, _ = _run(["check", "--wait", "3"], capsys)
        assert code == 0
        assert naps == [3, 3]
        # What it found is said once while nothing changes, not on every look.
        assert out.count("No export in this folder yet.") == 1
        assert out.count("Looking again every 3s") == 1
        assert "Export is complete" in out
        assert pm.MoveState.load(_state_root(temp_home)).export_seen_at

    def test_check_wait_alone_looks_every_few_seconds(self, temp_home, capsys):
        def sleep(seconds):
            _make_export(_exports(temp_home), "Demo")

        with patch.object(cli.time, "sleep", side_effect=sleep) as slept:
            code, _, _ = _run(["check", "--wait"], capsys)
        assert code == 0
        assert slept.call_args.args == (5,)

    def test_check_wait_gives_up_at_timeout(self, temp_home, capsys):
        clock = itertools.count(0.0, 100.0)
        with patch.object(cli.time, "sleep") as slept, \
             patch.object(cli.time, "monotonic", side_effect=lambda: next(clock)):
            code, _, err = _run(["check", "--wait", "--timeout", "10"], capsys)
        assert code == 2
        assert "Gave up after 10s" in err
        assert str(_exports(temp_home)) in err
        assert slept.call_count == 0

    def test_import_hands_out_the_script_and_names_the_export(self, temp_home, capsys):
        _run(["export", "--no-open"], capsys)
        root = _make_export(_exports(temp_home), "Demo")
        code, out, _ = _run(["import", "--no-open"], capsys)
        assert code == 0
        state_root = _state_root(temp_home)
        saved = state_root / pm.PROMPT_DIR / "import-script.js"
        assert f"Saved the import script to: {saved}" in out
        assert saved.read_bytes() == pm.script_text("import").encode("utf-8")
        assert (
            f"Export to import: Demo (Claude Code project; 2 file(s), 2 saved conversation(s), {_CODE_BYTES} bytes)."
            in out
        )
        assert "DESTINATION account" in out
        assert 'Press "Import Claude Project"' in out
        assert f"       {root}" in out
        assert "makes a NEW private project" in out
        assert "nothing is deleted" in out
        assert "arrives paused" in out and "press Resume" in out
        state = pm.MoveState.load(state_root)
        assert state.imported_at and state.export_seen_at
        assert state.export_path == str(root)
        assert state.carrier == pm.CARRIER_FOLDER

    def test_import_copies_the_import_script(self, temp_home, capsys):
        _make_export(_exports(temp_home), "Demo")
        with patch("os.geteuid", return_value=1000, create=True), \
             patch.object(sys, "argv", ["cswap", "project-move", "import", "--url", "https://claude.ai/new"]), \
             patch.object(pm, "open_url", return_value=False) as opened, \
             patch.object(pm, "copy_to_clipboard", return_value="pbcopy") as copied:
            cli.main()
        out = capsys.readouterr().out
        assert "Copied the import script to the clipboard (pbcopy)." in out
        assert copied.call_args.args[0] == pm.script_text("import")
        assert opened.call_args.args[0] == "https://claude.ai/new"
        assert "Could not open a browser; go to https://claude.ai/new" in out

    def test_import_of_a_regular_project_says_nothing_about_pausing(self, temp_home, capsys):
        _make_export(_exports(temp_home), "Recipes", kind="standard")
        code, out, _ = _run(["import", "--no-open"], capsys)
        assert code == 0
        assert "Export to import: Recipes (project;" in out
        assert "arrives paused" not in out

    def test_import_with_several_exports_points_at_the_folder(self, temp_home, capsys):
        folder = _exports(temp_home)
        _make_export(folder, "Demo")
        _make_export(folder, "Recipes", kind="standard")
        code, out, _ = _run(["import", "--no-open"], capsys)
        assert code == 0
        assert f"2 exports are ready in {folder}." in out
        assert f"       {folder}\n" in out
        assert "the script asks which one to import" in out
        assert "arrives paused" in out  # one of them may be a Claude Code project

    def test_import_without_an_export_warns_and_is_not_counted(self, temp_home, capsys):
        _run(["export", "--no-open"], capsys)
        code, out, _ = _run(["import", "--no-open"], capsys)
        # The script is still handed out: the export may be somewhere else.
        assert code == 0
        assert "Saved the import script to" in out
        assert f"No finished export of this move was found in {_exports(temp_home)}." in out
        assert "cswap project-move check" in out
        state = pm.MoveState.load(_state_root(temp_home))
        assert state.imported_at == "" and state.export_path == ""
        code, out, _ = _run([], capsys)
        assert "[next] 3." in out

    def test_import_from_a_folder_named_on_the_command_line(self, temp_home, tmp_path, capsys):
        root = _make_export(tmp_path / "usb stick", "Demo", age=86400)
        _run(["export", "--no-open"], capsys)
        code, out, _ = _run(["import", "--folder", str(root), "--no-open"], capsys)
        assert code == 0
        assert f"       {root}" in out
        state = pm.MoveState.load(_state_root(temp_home))
        assert state.imported_at
        assert state.export_path == str(root)
        # The folder kept for the next export is the one that holds it.
        assert state.folder == str(tmp_path / "usb stick")

    def test_the_steps_follow_the_move(self, temp_home, capsys):
        folder = _exports(temp_home)
        code, out, _ = _run([], capsys)
        assert code == 0
        assert f"Project move by browser script (folder {folder})" in out
        assert "[next] 1." in out
        assert "cswap project-move export" in out and "OWNER/NAME" not in out
        assert out.count("[    ]") == 5
        # Looking is not doing: nothing is saved, and no folder is made.
        assert not (_state_root(temp_home) / pm.STATE_FILE).exists()
        assert not folder.exists()

        _run(["export", "--no-open"], capsys)
        _, out, _ = _run(["steps"], capsys)
        assert "[done] 2." in out and "[next] 3." in out

        # The step list notices a finished export by itself.
        root = _make_export(folder, "Demo")
        _, out, _ = _run([], capsys)
        assert "[done] 3." in out and "[next] 4." in out
        assert out.rstrip().endswith(str(root))
        assert pm.MoveState.load(_state_root(temp_home)).export_seen_at

        _run(["import", "--no-open"], capsys)
        _, out, _ = _run([], capsys)
        assert out.count("[done]") == 6
        assert "All steps are done. To move another project: cswap project-move export" in out

    def test_export_again_mid_move_keeps_the_move(self, temp_home, capsys):
        with patch.object(pm, "_now_iso", return_value="2026-01-01T10:00:00"):
            _run(["export", "--no-open"], capsys)
        with patch.object(pm, "_now_iso", return_value="2026-01-01T11:00:00"):
            code, out, _ = _run(["export", "--no-open"], capsys)
        assert code == 0
        assert "Saved the export script to" in out
        assert pm.MoveState.load(_state_root(temp_home)).exported_at == "2026-01-01T10:00:00"

    def test_export_after_an_import_begins_a_new_move(self, temp_home, capsys):
        folder = _exports(temp_home)
        _make_export(folder, "First", age=600)
        _run(["import", "--no-open"], capsys)
        assert pm.MoveState.load(_state_root(temp_home)).imported_at

        _run(["export", "--no-open"], capsys)
        state = pm.MoveState.load(_state_root(temp_home))
        assert state.exported_at
        assert (state.imported_at, state.export_seen_at, state.export_path) == ("", "", "")
        # The first move's export is not the second's.
        code, out, _ = _run(["check"], capsys)
        assert code == 2
        assert "Saved before this move began." in out
        _make_export(folder, "Second")
        code, out, _ = _run(["check"], capsys)
        assert code == 0
        assert pm.MoveState.load(_state_root(temp_home)).export_path == str(folder / "Second")

    def test_the_script_stages_never_use_the_network(self, temp_home, capsys):
        with patch.object(pm.urllib.request, "urlopen", side_effect=AssertionError("network")) as urlopen:
            _run(["export", "--no-open"], capsys)
            _make_export(_exports(temp_home), "Demo")
            for argv in (["check"], [], ["import", "--no-open"], ["steps"]):
                code, _, _ = _run(argv, capsys)
                assert code == 0
        assert urlopen.call_count == 0

    def test_naming_a_repository_moves_by_prompt_and_export_alone_by_script(self, temp_home, capsys):
        with patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x")) as github:
            _run(["export", REPO, "--no-open"], capsys)
            root = _state_root(temp_home)
            assert pm.MoveState.load(root).carrier == pm.CARRIER_BRANCH
            # The stages after carry on with the move in hand.
            code, out, _ = _run(["import", "--no-open"], capsys)
            assert code == 0 and "Saved the import prompt to" in out

            asked = github.call_count
            code, out, _ = _run(["export", "--no-open"], capsys)
            assert code == 0 and "Saved the export script to" in out
            state = pm.MoveState.load(root)
            assert state.carrier == pm.CARRIER_FOLDER
            assert state.imported_at == ""
            assert state.repo == REPO  # still remembered, for a later move by prompt
            code, out, _ = _run(["check"], capsys)
            assert code == 2 and "No export in this folder yet." in out
            assert github.call_count == asked

            code, out, _ = _run(["export", REPO, "--no-open"], capsys)
            assert code == 0 and "Saved the export prompt to" in out
            assert pm.MoveState.load(root).carrier == pm.CARRIER_BRANCH

    def test_looking_at_the_other_ways_steps_does_not_switch_the_move(self, temp_home, tmp_path, capsys):
        with patch.object(pm, "check_repo", return_value=pm.RepoCheck(repo=REPO, branch="x")):
            _run(["export", REPO, "--no-open"], capsys)
            before = (_state_root(temp_home) / pm.STATE_FILE).read_text(encoding="utf-8")
            code, out, _ = _run(["steps", "--folder", str(tmp_path / "exports")], capsys)
            assert code == 0
            assert "Project move by browser script" in out
            # Shown from the start: the prompt move's progress is not this one's.
            assert "[next] 1." in out and "[done]" not in out
            assert (_state_root(temp_home) / pm.STATE_FILE).read_text(encoding="utf-8") == before

        _run(["export", "--no-open"], capsys)
        before = (_state_root(temp_home) / pm.STATE_FILE).read_text(encoding="utf-8")
        with patch.object(pm, "check_repo") as github:
            code, out, _ = _run(["steps", "other/repo"], capsys)
        assert code == 0
        assert "Project move via GitHub repository other/repo" in out
        assert "[next] 1." in out and "[done]" not in out
        assert github.call_count == 0
        assert (_state_root(temp_home) / pm.STATE_FILE).read_text(encoding="utf-8") == before


# ---------------------------------------------------------------------------
# CLI: by browser script, with the export saved as one .tar file
# ---------------------------------------------------------------------------


class TestCliArchive:
    def test_export_says_what_to_do_when_no_folder_window_opens(self, temp_home, capsys):
        code, out, _ = _run(["export", "--no-open"], capsys)
        assert code == 0
        assert 'If no folder window opens, press "Save as .tar instead"' in out
        assert "cswap project-move check --folder <path to the .tar>" in out

    def test_a_tar_given_to_export_is_refused(self, temp_home, tmp_path, capsys):
        archive = tmp_path / "beethoven.tar"
        code, out, err = _run(["export", "--folder", str(archive), "--no-open"], capsys)
        assert code == 1
        assert "saves into a folder" in err and "--folder" in err
        # Neither made in its place nor remembered.
        assert not archive.exists()
        assert not (_state_root(temp_home) / pm.STATE_FILE).exists()

    def test_check_takes_the_tar_and_import_points_at_it(self, temp_home, tmp_path, capsys):
        _run(["export", "--no-open"], capsys)
        archive = _make_archive(tmp_path / "Downloads", age=86400)
        code, out, _ = _run(["check", "--folder", str(archive)], capsys)
        assert code == 0
        assert str(archive) in out.splitlines()
        assert "beethoven  (Claude Code project, saved " in out
        assert f"Export is complete: 3 file(s), 2 saved conversation(s), {_ARCHIVE_BYTES} bytes" in out
        assert "then run: cswap project-move import" in out
        assert "To export a project into this folder" not in out
        state = pm.MoveState.load(_state_root(temp_home))
        assert state.export_path == str(archive)
        # The folder kept for the next export is the one the .tar sits in.
        assert state.folder == str(tmp_path / "Downloads")
        assert archive.is_file()

        code, out, _ = _run(["import", "--no-open"], capsys)
        assert code == 0
        assert "Export to import: beethoven (Claude Code project;" in out
        assert 'Press "Import from a .tar file instead" and choose this file:' in out
        assert f"       {archive}" in out
        assert 'Press "Import Claude Project"' not in out
        assert pm.MoveState.load(_state_root(temp_home)).imported_at

        code, out, _ = _run([], capsys)
        assert code == 0
        assert out.count("[done]") == 6
        assert 'press "Import from a .tar file instead" and choose this file' in out
        assert f"           {archive}" in out

    def test_a_tar_in_the_exports_folder_is_found(self, temp_home, capsys):
        _run(["export", "--no-open"], capsys)
        archive = _make_archive(_exports(temp_home))
        code, out, _ = _run(["check"], capsys)
        assert code == 0
        assert "beethoven  (Claude Code project, saved " in out
        assert f"[{archive}]" not in out  # in the folder itself, so no need to say where
        assert pm.MoveState.load(_state_root(temp_home)).export_path == str(archive)
        code, out, _ = _run(["import", "--no-open"], capsys)
        assert code == 0
        assert "Import from a .tar file instead" in out and f"       {archive}" in out

    def test_check_says_what_a_tar_is_missing(self, temp_home, capsys):
        def tweak(root: Path) -> None:
            (root / "Files" / "notes.md").unlink()
            (root / "Files" / "data" / "table.csv").write_bytes(b"a,b\n")

        _make_archive(_exports(temp_home), before=tweak)
        code, out, _ = _run(["check"], capsys)
        assert code == 2
        assert "Export is NOT complete" in out
        assert "1 file(s) listed in export.json but not in the .tar: Files/notes.md" in out
        assert "1 file(s) in the .tar with another size than recorded: Files/data/table.csv" in out
        assert "Export the project again." in out
        assert "project-move import" not in out

    def test_a_damaged_tar_is_explained(self, temp_home, tmp_path, capsys):
        broken = tmp_path / "broken.tar"
        broken.write_bytes(b"not a tar\n" * 50)
        code, out, _ = _run(["check", "--folder", str(broken)], capsys)
        assert code == 2
        assert "  broken.tar" in out
        assert "Not usable: the .tar is not a tar archive" in out
        assert "then run: cswap project-move import" not in out
        assert pm.MoveState.load(_state_root(temp_home)).export_seen_at == ""
        # A real one whose download did not finish.
        cut = _cut_short(_make_archive(tmp_path / "cut"))
        code, out, _ = _run(["check", "--folder", str(cut)], capsys)
        assert code == 2
        assert "  beethoven.tar" in out
        assert "Not usable: the .tar is cut short (the download did not finish)" in out
        assert pm.MoveState.load(_state_root(temp_home)).export_seen_at == ""

    def test_what_is_no_export_is_left_out_of_the_listing(self, temp_home, capsys):
        folder = _exports(temp_home)
        archive = _make_archive(folder)
        with tarfile.open(folder / "node_modules.tar", "w") as tar:
            entry = tarfile.TarInfo("node_modules/left-pad/index.js")
            entry.size = 2
            tar.addfile(entry, io.BytesIO(b"hi"))
        (folder / "x.tar").write_bytes(b"not a tar\n" * 50)
        _cut_short(Path(shutil.copy(archive, folder / "cut.tar")))
        code, out, _ = _run(["check"], capsys)
        assert code == 0
        assert "node_modules" not in out and "x.tar" not in out
        assert "  cut.tar" in out and "Not usable: the .tar is cut short" in out
        assert "beethoven  (Claude Code project, saved " in out
        assert pm.MoveState.load(_state_root(temp_home)).export_path == str(archive)

    def test_a_tar_that_is_not_there(self, temp_home, tmp_path, capsys):
        for stage in ("check", "import"):
            code, out, _ = _run([stage, "--folder", str(tmp_path / "nowhere.tar"), "--no-open"], capsys)
            assert code == (2 if stage == "check" else 0)
            if stage == "check":
                assert "There is no such file." in out
            assert not (tmp_path / "nowhere.tar").exists()
            # The folder kept is the one the .tar would be in, not the .tar:
            # the next export saves into a folder.
            state = pm.MoveState.load(_state_root(temp_home))
            assert state.folder == str(tmp_path) and state.export_path == ""
        code, out, _ = _run(["export", "--no-open"], capsys)
        assert code == 0
        assert f"       {tmp_path}" in out
        code, out, _ = _run([], capsys)
        assert code == 0
        assert f'cswap project-move export --folder "{tmp_path}"' in out
        assert "nowhere.tar" not in out

    def test_help_mentions_the_tar(self, capsys):
        with patch.object(sys, "argv", ["cswap", "project-move", "--help"]):
            with pytest.raises(SystemExit):
                cli.main()
        assert "saved as one .tar file" in capsys.readouterr().out
